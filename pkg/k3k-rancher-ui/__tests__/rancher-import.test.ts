import { addImportAddon, defaultRancherName, importSecretName, safeName } from '../utils/rancher-import';

describe('rancher import helpers', () => {
  it('builds valid Kubernetes names', () => {
    expect(safeName('Rancher_Import', 'My.Cluster')).toBe('rancher-import-my-cluster');
    expect(safeName('a'.repeat(80))).toHaveLength(63);
    expect(safeName('-x-', '')).toBe('x');
  });

  it('derives secret and Rancher cluster names from the k3k name', () => {
    expect(importSecretName('rustdesk')).toBe('rancher-import-rustdesk');
    expect(defaultRancherName('rustdesk')).toBe('rustdesk');
  });

  it('adds the import addon once, keeping other addons', () => {
    const cluster = { spec: { addons: [{ secretRef: 'other' }] } };

    addImportAddon(cluster, 'rancher-import-x');
    addImportAddon(cluster, 'rancher-import-x');

    expect(cluster.spec.addons).toStrictEqual([{ secretRef: 'other' }, { secretRef: 'rancher-import-x' }]);
  });
});
