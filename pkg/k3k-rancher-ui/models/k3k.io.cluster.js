import SteveModel from '@shell/plugins/steve/steve-class';
import { SECRET } from '@shell/config/types';
import { base64Decode } from '@shell/utils/crypto';
import { downloadFile } from '@shell/utils/download';
import { insertAt } from '@shell/utils/array';
import {
  ANNOTATIONS, defaultRancherName, disableRancherVersionManagement, findRancherCluster, importSecretName, prepareRancherImport
} from '../utils/rancher-import';

const KUBECONFIG_KEY = 'kubeconfig.yaml';

export default class K3kCluster extends SteveModel {
  // Use the k3k-reported phase (Pending/Provisioning/Ready/Failed/...) as the badge state
  get state() {
    const phase = this.status?.phase;

    return phase ? phase.toLowerCase() : super.state;
  }

  get stateObj() {
    const phase = this.status?.phase;

    if (!phase) {
      return super.stateObj;
    }

    return {
      name:          phase.toLowerCase(),
      error:         phase === 'Failed',
      transitioning: ['Pending', 'Provisioning', 'Terminating'].includes(phase),
    };
  }

  get mode() {
    return this.spec?.mode || 'shared';
  }

  get isReady() {
    return this.status?.phase === 'Ready';
  }

  // "fleet-default/<name>" of the linked Rancher cluster, if imported by this extension
  get rancherClusterRef() {
    return this.metadata?.annotations?.[ANNOTATIONS.RANCHER_CLUSTER];
  }

  get isImported() {
    return !!this.rancherClusterRef;
  }

  // Ephemeral clusters lose their datastore when the server pod restarts, and adding
  // the import addon later restarts it, so only offer the after-the-fact import for dynamic.
  get canImportExisting() {
    return this.isReady && !this.isImported && this.spec?.persistence?.type !== 'ephemeral' && !!this.links?.update;
  }

  get rootDispatch() {
    return (action, payload) => this.$dispatch(action, payload, { root: true });
  }

  get _availableActions() {
    const out = super._availableActions;

    insertAt(out, 0, {
      action:  'downloadKubeconfig',
      label:   'Download KubeConfig',
      icon:    'icon icon-download',
      enabled: this.isReady,
    });

    insertAt(out, 1, {
      action:  'importIntoRancher',
      label:   'Import into Rancher',
      icon:    'icon icon-upload',
      enabled: this.canImportExisting,
    });

    insertAt(out, 2, {
      action:  'goToRancherCluster',
      label:   'Open in Rancher',
      icon:    'icon icon-external-link',
      enabled: this.isImported,
    });

    insertAt(out, 3, {
      action:  'disableRancherVersionManagement',
      label:   'Disable Rancher Version Management',
      icon:    'icon icon-lock',
      enabled: this.isImported,
    });

    insertAt(out, 4, { divider: true });

    return out;
  }

  // Import a cluster that is already running. k3k rolls the server StatefulSet to
  // mount the new addon; the k3s server applies the agent manifest when it comes back.
  async importIntoRancher() {
    try {
      const hostClusterId = this.$rootGetters['currentCluster']?.id;

      await prepareRancherImport(this.rootDispatch, this, {
        rancherName: defaultRancherName(this.metadata.name),
        hostClusterId,
      });
      await this.save();

      this.$dispatch('growl/success', {
        title:   'Importing into Rancher',
        message: `${ this.metadata.name } will register once its server pod restarts.`,
      }, { root: true });
    } catch (err) {
      this.$dispatch('growl/error', {
        title:   'Import into Rancher failed',
        message: err?.message || String(err),
      }, { root: true });
    }
  }

  // For clusters imported before 0.3.0: stop Rancher from running system-upgrade-controller
  // plans in the virtual cluster (in shared mode those jobs target the real host nodes)
  async disableRancherVersionManagement() {
    try {
      const prov = await findRancherCluster(this.rootDispatch, this.rancherClusterRef);
      const mgmtId = prov?.status?.clusterName;

      if (!mgmtId) {
        throw new Error(`Rancher cluster ${ this.rancherClusterRef } not found`);
      }

      await disableRancherVersionManagement(this.rootDispatch, mgmtId);

      this.$dispatch('growl/success', {
        title:   'Rancher version management disabled',
        message: `Rancher will remove system-upgrade-controller and its plans from ${ this.metadata.name }.`,
      }, { root: true });
    } catch (err) {
      this.$dispatch('growl/error', {
        title:   'Could not disable Rancher version management',
        message: err?.message || String(err),
      }, { root: true });
    }
  }

  async goToRancherCluster() {
    const prov = await findRancherCluster(this.rootDispatch, this.rancherClusterRef);
    const mgmtId = prov?.status?.clusterName;

    if (!mgmtId) {
      this.$dispatch('growl/warning', {
        title:   'Rancher cluster not found',
        message: `${ this.rancherClusterRef } does not exist or is not registered yet.`,
      }, { root: true });

      return;
    }

    this.currentRouter().push({ name: 'c-cluster-explorer', params: { cluster: mgmtId } });
  }

  // Deleting the virtual cluster also removes what this extension created for it:
  // the linked Rancher cluster and the import Secret (which k3k doesn't own).
  async remove(...args) {
    const ref = this.rancherClusterRef;
    const ns = this.metadata.namespace;
    const secretName = importSecretName(this.metadata.name);

    const res = await super.remove(...args);

    if (ref) {
      const prov = await findRancherCluster(this.rootDispatch, ref);

      await prov?.remove().catch(() => {});

      try {
        const secret = await this.$dispatch('find', { type: SECRET, id: `${ ns }/${ secretName }` });

        await secret.remove();
      } catch (e) {}
    }

    return res;
  }

  // k3k writes the admin kubeconfig to a Secret in the cluster's namespace,
  // owned by the Cluster. Its name is normally k3k-<name>-kubeconfig, but k3k
  // hashes long names, so fall back to matching the owner reference.
  async findKubeconfigSecret() {
    const ns = this.metadata.namespace;
    const expected = `k3k-${ this.metadata.name }-kubeconfig`;

    try {
      return await this.$dispatch('find', { type: SECRET, id: `${ ns }/${ expected }` });
    } catch (e) {
      const secrets = await this.$dispatch('findAll', { type: SECRET, opt: { namespaced: ns } });

      return secrets.find((s) => s.metadata?.namespace === ns &&
        (s.metadata?.ownerReferences || []).some((o) => o.kind === 'Cluster' && o.uid === this.metadata.uid) &&
        s.data?.[KUBECONFIG_KEY]
      );
    }
  }

  async downloadKubeconfig() {
    try {
      const secret = await this.findKubeconfigSecret();
      const encoded = secret?.data?.[KUBECONFIG_KEY];

      if (!encoded) {
        throw new Error('kubeconfig secret not found yet');
      }

      await downloadFile(`${ this.metadata.name }-kubeconfig.yaml`, base64Decode(encoded), 'application/yaml');
    } catch (err) {
      this.$dispatch('growl/error', {
        title:   'Unable to download kubeconfig',
        message: err?.message || String(err),
      }, { root: true });
    }
  }
}
