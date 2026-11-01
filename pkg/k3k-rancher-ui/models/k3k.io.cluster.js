import SteveModel from '@shell/plugins/steve/steve-class';
import { SECRET } from '@shell/config/types';
import { base64Decode } from '@shell/utils/crypto';
import { downloadFile } from '@shell/utils/download';
import { insertAt } from '@shell/utils/array';

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

  get _availableActions() {
    const out = super._availableActions;

    insertAt(out, 0, {
      action:  'downloadKubeconfig',
      label:   'Download KubeConfig',
      icon:    'icon icon-download',
      enabled: this.isReady,
    });

    insertAt(out, 1, { divider: true });

    return out;
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
