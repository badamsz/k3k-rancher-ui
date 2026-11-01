import { CAPI, MANAGEMENT, NORMAN, SECRET } from '@shell/config/types';
import { base64Encode } from '@shell/utils/crypto';

export const FLEET_WORKSPACE = 'fleet-default';

// Annotations linking the k3k Cluster and the Rancher cluster to each other
export const ANNOTATIONS = {
  RANCHER_CLUSTER: 'k3k-rancher-ui.badamsz.github.io/rancher-cluster',
  HOST_CLUSTER:    'k3k-rancher-ui.badamsz.github.io/host-cluster',
  K3K_CLUSTER:     'k3k-rancher-ui.badamsz.github.io/k3k-cluster',
};

const MANIFEST_KEY = 'rancher-import.yaml';

// Rancher's per-cluster switch for managing an imported K3s/RKE2 cluster's version
// (values: true | false | system-default). Validated on the management cluster.
export const VERSION_MANAGEMENT_ANNOTATION = 'rancher.io/imported-cluster-version-management';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rancher store errors are often plain objects (e.g. { _status, message, code })
export function describeError(err) {
  if (!err) {
    return 'unknown error';
  }
  if (typeof err === 'string') {
    return err;
  }

  const status = err._status || err.status;
  const msg = err.message || err._statusText || err.statusText || err.code;

  if (msg) {
    return status ? `${ msg } (HTTP ${ status })` : msg;
  }

  try {
    return JSON.stringify(err);
  } catch (e) {
    return String(err);
  }
}

// Run one step of the import, labelling any failure with the step it happened in
async function step(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[k3k-rancher-ui] ${ label } failed`, err); // eslint-disable-line no-console

    throw new Error(`Import into Rancher, ${ label }: ${ describeError(err) }`);
  }
}

// Kubernetes object names: lowercase alphanumerics and '-', max 63 chars
export function safeName(...parts) {
  return parts.filter(Boolean).join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
}

export function importSecretName(k3kName) {
  return safeName('rancher-import', k3kName);
}

export function defaultRancherName(k3kName) {
  return safeName(k3kName);
}

/**
 * Wait for Rancher to assign the management cluster ID (status.clusterName) and
 * produce a registration token with a manifest URL.
 *
 * Polls the API with force:true rather than relying on the in-memory model
 * (as Rancher's own waitForMgmt/getOrCreateToken do): with server-side pagination
 * enabled the UI doesn't watch provisioning clusters, so that copy never updates.
 */
export async function waitForRegistrationToken(dispatch, provCluster, timeoutMs = 120000, intervalMs = 2000) {
  const id = `${ provCluster.metadata.namespace }/${ provCluster.metadata.name }`;
  const deadline = Date.now() + timeoutMs;
  let mgmtId = provCluster.status?.clusterName;
  let created = false;

  while (Date.now() < deadline) {
    if (!mgmtId) {
      const fresh = await dispatch('management/find', {
        type: CAPI.RANCHER_CLUSTER, id, opt: { force: true }
      });

      mgmtId = fresh?.status?.clusterName;
    }

    if (mgmtId) {
      const tokens = await dispatch('rancher/findAll', { type: NORMAN.CLUSTER_TOKEN, opt: { force: true } });
      const token = (tokens || []).find((t) => t.clusterId === mgmtId);

      if (token?.manifestUrl) {
        return token;
      }

      // Rancher normally creates a default token for imported clusters; make one if it hasn't
      if (!token && !created) {
        created = true;

        try {
          const neu = await dispatch('rancher/create', { type: NORMAN.CLUSTER_TOKEN, clusterId: mgmtId });

          await neu.save();
        } catch (e) {}
      }
    }

    await sleep(intervalMs);
  }

  throw new Error(mgmtId ? `Rancher cluster ${ mgmtId } has no registration token after ${ timeoutMs / 1000 }s` : `Rancher did not assign a management cluster ID to ${ id } within ${ timeoutMs / 1000 }s`);
}

/**
 * Turn off Rancher's version management for the imported cluster. Rancher upgrades
 * imported K3s clusters with system-upgrade-controller, which replaces the k3s binary
 * on each node; k3k's servers are pods it manages itself, so the version is changed
 * from the k3k Cluster (spec.version) instead.
 */
export async function disableRancherVersionManagement(dispatch, mgmtId) {
  const readBack = async() => {
    const mgmt = await dispatch('management/find', {
      type: MANAGEMENT.CLUSTER, id: mgmtId, opt: { force: true }
    });

    return mgmt?.metadata?.annotations?.[VERSION_MANAGEMENT_ANNOTATION];
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    if (await readBack() === 'false') {
      return;
    }

    try {
      // Same path Rancher's own "Edit Config" page uses: the Norman (v3) cluster object
      const norman = await dispatch('rancher/find', {
        type: NORMAN.CLUSTER, id: mgmtId, opt: { force: true }
      });

      norman.annotations = norman.annotations || {};
      norman.annotations[VERSION_MANAGEMENT_ANNOTATION] = 'false';
      await norman.save();
    } catch (err) {
      // Rancher updates a new cluster object a lot right after creation; retry on conflict
      if ((err?._status || err?.status) !== 409) {
        throw err;
      }
    }

    await sleep(2000);
  }

  if (await readBack() !== 'false') {
    throw new Error(`${ VERSION_MANAGEMENT_ANNOTATION } did not stick on ${ mgmtId }`);
  }
}

/**
 * Create an "Imported" cluster in Rancher and fetch its registration manifest.
 *
 * @param {Function} dispatch root-level store dispatch: (action, payload) => Promise
 * @param {object}   opts { rancherName, hostClusterId, k3kNamespace, k3kName }
 * @returns {{ provCluster, manifest }}
 */
export async function createRancherClusterAndManifest(dispatch, {
  rancherName, hostClusterId, k3kNamespace, k3kName
}) {
  const saved = await step(`step 1/3 (create Rancher cluster ${ FLEET_WORKSPACE }/${ rancherName })`, async() => {
    const provCluster = await dispatch('management/create', {
      type:     CAPI.RANCHER_CLUSTER,
      metadata: {
        name:        rancherName,
        namespace:   FLEET_WORKSPACE,
        annotations: {
          [ANNOTATIONS.HOST_CLUSTER]: hostClusterId,
          [ANNOTATIONS.K3K_CLUSTER]:  `${ k3kNamespace }/${ k3kName }`,
        },
      },
      spec: {},
    });

    return provCluster.save();
  });

  try {
    const manifest = await step('step 2/3 (fetch registration manifest)', async() => {
      const token = await waitForRegistrationToken(dispatch, saved);

      try {
        await disableRancherVersionManagement(dispatch, token.clusterId);
      } catch (err) {
        // Not fatal for the import itself, but the user must know: in shared mode Rancher's
        // upgrade plans would target the real host nodes
        console.warn(`[k3k-rancher-ui] could not disable Rancher version management on ${ token.clusterId }`, err); // eslint-disable-line no-console
        dispatch('growl/warning', {
          title:   'Rancher version management is still enabled',
          message: `Use the "Disable Rancher Version Management" action on this cluster, or set it to Disabled in Cluster Management. (${ describeError(err) })`,
          timeout: 0,
        }).catch(() => {});
      }

      // The manifestUrl uses Rancher's server-url setting, which may not be the
      // origin we're browsing on. The import endpoint is the same path on any origin.
      const path = new URL(token.manifestUrl, window.location.origin).pathname;
      const res = await fetch(path, { credentials: 'same-origin' });

      if (!res.ok) {
        throw new Error(`GET ${ path } returned HTTP ${ res.status }`);
      }

      return res.text();
    });

    return { provCluster: saved, manifest };
  } catch (err) {
    // Don't leave an orphaned "pending" cluster behind in Rancher
    await saved.remove().catch(() => {});
    throw err;
  }
}

/**
 * Store the registration manifest as a Secret next to the k3k Cluster.
 * k3k mounts addon Secrets into the k3s server's auto-deploy manifests dir,
 * so the virtual cluster applies cattle-cluster-agent itself and registers.
 */
export async function createImportSecret(dispatch, { namespace, k3kName, manifest }) {
  const name = importSecretName(k3kName);

  // Replace a stale secret from an earlier attempt
  try {
    const existing = await dispatch('cluster/find', { type: SECRET, id: `${ namespace }/${ name }` });

    await existing.remove();
  } catch (e) {}

  const secret = await dispatch('cluster/create', {
    type:     SECRET,
    _type:    'Opaque',
    metadata: {
      name,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'k3k-rancher-ui' },
    },
    data: { [MANIFEST_KEY]: base64Encode(manifest) },
  });

  await secret.save();

  return name;
}

export function addImportAddon(k3kCluster, secretName) {
  const addons = (k3kCluster.spec.addons || []).filter((a) => a.secretRef !== secretName);

  addons.push({ secretRef: secretName });
  k3kCluster.spec.addons = addons;
}

/**
 * Full flow: Rancher cluster -> manifest -> Secret -> addon + link annotation on the k3k Cluster.
 * Mutates k3kCluster but does not save it.
 */
export async function prepareRancherImport(dispatch, k3kCluster, { rancherName, hostClusterId }) {
  const namespace = k3kCluster.metadata.namespace;
  const k3kName = k3kCluster.metadata.name;

  const { provCluster, manifest } = await createRancherClusterAndManifest(dispatch, {
    rancherName, hostClusterId, k3kNamespace: namespace, k3kName
  });

  try {
    const secretName = await step(`step 3/3 (create Secret ${ namespace }/${ importSecretName(k3kName) })`, () => createImportSecret(dispatch, {
      namespace, k3kName, manifest
    }));

    addImportAddon(k3kCluster, secretName);
    k3kCluster.metadata.annotations = k3kCluster.metadata.annotations || {};
    k3kCluster.metadata.annotations[ANNOTATIONS.RANCHER_CLUSTER] = `${ FLEET_WORKSPACE }/${ provCluster.metadata.name }`;

    return provCluster;
  } catch (err) {
    await provCluster.remove().catch(() => {});
    throw err;
  }
}

export async function findRancherCluster(dispatch, ref) {
  if (!ref) {
    return null;
  }

  try {
    return await dispatch('management/find', {
      type: CAPI.RANCHER_CLUSTER, id: ref, opt: { force: true }
    });
  } catch (e) {
    return null;
  }
}
