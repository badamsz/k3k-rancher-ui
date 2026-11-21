// Health checks for a k3k cluster's server (etcd) pods and their volumes.
//
// These cover the failure modes that take k3k HA clusters down during host
// maintenance (node drains, Harvester upgrades):
//
// - Server pods carry the `etcdpod.k3k.io/finalizer`. k3k removes it only after
//   removing the pod's etcd member through the virtual cluster's API, so when every
//   server is down at once the finalizers can never clear: pods sit in Terminating
//   forever and node drains hang (e.g. a Harvester upgrade stuck at "Pre-drained").
// - etcd peer URLs are pod IPs. Each restart changes the IP; with two or more
//   servers on the same host node, one node reboot can cost the cluster its quorum.
// - Each time k3k removes a server's member and the pod comes back, k3s moves the
//   old data aside to server/db/etcd-backup-<ts> and never cleans it up. On the
//   default 2G volume this fills the disk after a few drains.

export const ETCD_FINALIZER = 'etcdpod.k3k.io/finalizer';

// Below this the volume fills up after a handful of member re-joins
export const MIN_RECOMMENDED_BYTES = 5 * 1024 ** 3;
export const DEFAULT_STORAGE_SIZE = '10Gi';

// How long a deleted pod may stay in Terminating before we call it stuck
export const STUCK_AFTER_MS = 2 * 60 * 1000;

export function serverStatefulSetName(clusterName) {
  return `k3k-${ clusterName }-server`;
}

export function serverPvcName(clusterName, ordinal) {
  return `varlibrancherk3s-${ serverStatefulSetName(clusterName) }-${ ordinal }`;
}

export function isServerPod(pod, clusterName) {
  const sts = serverStatefulSetName(clusterName);
  const owned = (pod.metadata?.ownerReferences || []).some((o) => o.kind === 'StatefulSet' && o.name === sts);

  return owned || new RegExp(`^${ sts }-\\d+$`).test(pod.metadata?.name || '');
}

export function serverPods(pods, cluster) {
  const ns = cluster.metadata?.namespace;

  return (pods || [])
    .filter((p) => p.metadata?.namespace === ns && isServerPod(p, cluster.metadata?.name))
    .sort((a, b) => ordinalOf(a) - ordinalOf(b));
}

export function serverPvcs(pvcs, cluster) {
  const ns = cluster.metadata?.namespace;
  const prefix = `varlibrancherk3s-${ serverStatefulSetName(cluster.metadata?.name) }-`;

  return (pvcs || []).filter((p) => p.metadata?.namespace === ns && (p.metadata?.name || '').startsWith(prefix));
}

export function ordinalOf(pod) {
  const m = /-(\d+)$/.exec(pod.metadata?.name || '');

  return m ? parseInt(m[1], 10) : -1;
}

export function isPodReady(pod) {
  return (pod.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');
}

function isRunning(pod) {
  return (pod.status?.containerStatuses || []).some((c) => !!c.state?.running);
}

// Deleted, held only by the k3k etcd finalizer, no container running, and old enough
// that k3k clearly isn't going to clear it.
export function isStuckTerminating(pod, now = Date.now()) {
  const deleted = pod.metadata?.deletionTimestamp;

  if (!deleted || !(pod.metadata?.finalizers || []).includes(ETCD_FINALIZER)) {
    return false;
  }

  return !isRunning(pod) && now - new Date(deleted).getTime() >= STUCK_AFTER_MS;
}

// Finalizer list without k3k's etcd finalizer (keeps anything else that's there)
export function withoutEtcdFinalizer(finalizers) {
  return (finalizers || []).filter((f) => f !== ETCD_FINALIZER);
}

const UNITS = {
  '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6
};

// Kubernetes quantity -> bytes (NaN when unparseable)
export function parseQuantity(q) {
  if (typeof q === 'number') {
    return q;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kMGTPE]i?)?\s*$/.exec(q || '');

  if (!m) {
    return NaN;
  }

  return parseFloat(m[1]) * UNITS[m[2] || ''];
}

function pvcBytes(pvc) {
  return parseQuantity(pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage);
}

/**
 * Summarise server health. Returns { servers: [...], warnings: [...] } where each
 * warning is { id, level: 'error'|'warning'|'info', message, pods? }.
 */
export function serverHealth(cluster, pods, pvcs, now = Date.now()) {
  const desired = cluster.spec?.servers ?? 1;
  const sp = serverPods(pods, cluster);
  const volumes = serverPvcs(pvcs, cluster);
  const warnings = [];

  const servers = sp.map((pod) => {
    const pvc = volumes.find((v) => v.metadata.name === serverPvcName(cluster.metadata.name, ordinalOf(pod)));

    return {
      name:     pod.metadata.name,
      node:     pod.spec?.nodeName || '',
      ready:    isPodReady(pod),
      stuck:    isStuckTerminating(pod, now),
      deleting: !!pod.metadata?.deletionTimestamp,
      restarts: (pod.status?.containerStatuses || []).reduce((n, c) => n + (c.restartCount || 0), 0),
      volume:   pvc ? (pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage) : '',
    };
  });

  const stuck = sp.filter((p) => isStuckTerminating(p, now)).map((p) => p.metadata.name);

  if (stuck.length) {
    warnings.push({
      id:      'stuck',
      level:   'error',
      pods:    stuck,
      message: `${ stuck.join(', ') } ${ stuck.length === 1 ? 'is' : 'are' } stuck terminating on the k3k etcd finalizer. ` +
        'This blocks node drains (e.g. a Harvester upgrade stuck at "Pre-drained"). Use "Release stuck server pods".',
    });
  }

  const ready = servers.filter((s) => s.ready && !s.deleting).length;
  const quorum = Math.floor(desired / 2) + 1;

  if (desired > 1 && ready < desired) {
    warnings.push({
      id:      ready < quorum ? 'no-quorum' : 'degraded',
      level:   ready < quorum ? 'error' : 'warning',
      message: ready < quorum ? `Only ${ ready }/${ desired } servers are ready: etcd has likely lost quorum. See the README's quorum recovery runbook.` : `${ ready }/${ desired } servers are ready. Don't drain or reboot a host node until all servers are ready.`,
    });
  }

  if (desired > 1) {
    const byNode = {};

    servers.filter((s) => s.node && !s.deleting).forEach((s) => {
      (byNode[s.node] = byNode[s.node] || []).push(s.name);
    });

    const crowded = Object.entries(byNode).filter(([, names]) => names.length >= quorum);

    crowded.forEach(([node, names]) => {
      warnings.push({
        id:      `colocated-${ node }`,
        level:   'warning',
        pods:    names,
        message: `${ names.join(' and ') } ${ names.length === 2 ? 'both' : 'all' } run on ${ node }: rebooting that node loses etcd quorum. ` +
          'Enable "Spread servers across host nodes" on the edit form, while all servers are ready.',
      });
    });
  }

  const small = volumes.filter((v) => pvcBytes(v) < MIN_RECOMMENDED_BYTES);

  if (small.length && cluster.spec?.persistence?.type !== 'ephemeral') {
    warnings.push({
      id:      'small-volumes',
      level:   'warning',
      message: `${ small.length } server volume(s) are under 5Gi. k3s keeps etcd snapshots and etcd-backup-* copies there; small volumes fill up after a few node drains. Use "Expand server volumes".`,
    });
  }

  return {
    servers, warnings, desired, ready
  };
}

// Required pod anti-affinity between one cluster's server pods (k3k labels them
// cluster=<name>, role=server). A server that can't get its own node stays Pending,
// which keeps quorum; letting two share a node risks losing it on a single reboot.
export function serverSpreadTerm(clusterName) {
  return {
    topologyKey:   'kubernetes.io/hostname',
    labelSelector: { matchLabels: { cluster: clusterName, role: 'server' } },
  };
}

function isSpreadTerm(term, clusterName) {
  const labels = term?.labelSelector?.matchLabels || {};

  return term?.topologyKey === 'kubernetes.io/hostname' && labels.role === 'server' && labels.cluster === clusterName;
}

export function hasServerSpread(spec, clusterName) {
  const terms = spec?.serverAffinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution || [];

  return terms.some((t) => isSpreadTerm(t, clusterName));
}

// Add or remove our anti-affinity term, leaving any other affinity rules untouched
export function setServerSpread(spec, clusterName, enabled) {
  const terms = (spec.serverAffinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution || [])
    .filter((t) => !isSpreadTerm(t, clusterName));

  if (enabled) {
    terms.push(serverSpreadTerm(clusterName));
  }

  if (terms.length) {
    spec.serverAffinity = spec.serverAffinity || {};
    spec.serverAffinity.podAntiAffinity = { ...spec.serverAffinity.podAntiAffinity, requiredDuringSchedulingIgnoredDuringExecution: terms };

    return spec;
  }

  if (spec.serverAffinity?.podAntiAffinity) {
    delete spec.serverAffinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution;
    if (!Object.keys(spec.serverAffinity.podAntiAffinity).length) {
      delete spec.serverAffinity.podAntiAffinity;
    }
    if (!Object.keys(spec.serverAffinity).length) {
      delete spec.serverAffinity;
    }
  }

  return spec;
}

// True when the requested size is a valid quantity strictly larger than every current volume
export function validateExpansion(size, pvcs) {
  const want = parseQuantity(size);

  if (Number.isNaN(want)) {
    return `"${ size }" is not a valid size (e.g. 10Gi)`;
  }
  const biggest = Math.max(0, ...(pvcs || []).map(pvcBytes).filter((n) => !Number.isNaN(n)));

  if (want <= biggest) {
    return `New size must be larger than the current volumes`;
  }

  return null;
}
