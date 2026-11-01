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

describe('describeError', () => {
  it('formats Rancher store error objects', () => {
    const { describeError } = jest.requireActual('../utils/rancher-import');

    expect(describeError({ _status: 403, message: 'forbidden' })).toBe('forbidden (HTTP 403)');
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('plain')).toBe('plain');
  });
});

describe('waitForRegistrationToken', () => {
  const { waitForRegistrationToken } = jest.requireActual('../utils/rancher-import');
  const prov = { metadata: { namespace: 'fleet-default', name: 'vc' }, status: {} };

  it('polls until the mgmt cluster ID and token appear', async() => {
    let finds = 0;
    const dispatch = jest.fn(async(action: string) => {
      if (action === 'management/find') {
        finds++;

        return { status: finds >= 2 ? { clusterName: 'c-abc' } : {} };
      }
      if (action === 'rancher/findAll') {
        return [{ clusterId: 'c-other', manifestUrl: 'x' }, { clusterId: 'c-abc', manifestUrl: 'https://r/v3/import/t_c-abc.yaml' }];
      }
    });

    const token = await waitForRegistrationToken(dispatch, prov, 1000, 1);

    expect(token.manifestUrl).toBe('https://r/v3/import/t_c-abc.yaml');
    expect(finds).toBe(2);
  });

  it('times out with a clear message when no ID is assigned', async() => {
    const dispatch = jest.fn(async() => ({ status: {} }));

    await expect(waitForRegistrationToken(dispatch, prov, 20, 1)).rejects.toThrow('did not assign a management cluster ID');
  });
});
