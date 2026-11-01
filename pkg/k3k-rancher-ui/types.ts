export const PRODUCT_NAME = 'k3k';

export const K3K = {
  CLUSTER:  'k3k.io.cluster',
  POLICY:   'k3k.io.virtualclusterpolicy',
  SNAPSHOT: 'k3k.io.etcdsnapshot',
};

export const MODES = ['shared', 'virtual'];

export const PERSISTENCE_TYPES = ['dynamic', 'ephemeral'];

export const EXPOSE_TYPES = ['none', 'loadBalancer', 'nodePort', 'ingress'];

// rancher/k3s image tags look like v1.36.5-k3s1 (or v1.36.6-rc1-k3s1)
export const K3S_IMAGE_TAG = /^v\d+\.\d+\.\d+(-rc\d+)?-k3s\d+$/;

/**
 * k3k uses spec.version verbatim as the rancher/k3s image tag. Accept the forms
 * people naturally type (release name "v1.36.5+k3s1", "1.36.5") and return a
 * valid tag, or '' when left blank (k3k then follows the host version).
 */
export function normalizeK3sVersion(input?: string): string {
  let v = (input || '').trim();

  if (!v) {
    return '';
  }

  v = v.replace(/\+/g, '-');

  if (!v.startsWith('v')) {
    v = `v${ v }`;
  }

  if (!/-k3s\d+$/.test(v)) {
    v = `${ v }-k3s1`;
  }

  return v;
}

// Inverse of normalizeK3sVersion for display/matching against Rancher's release list
// (v1.36.5-k3s1 -> v1.36.5+k3s1)
export function toReleaseName(tag?: string): string {
  return (tag || '').replace(/-k3s(\d+)$/, '+k3s$1');
}
