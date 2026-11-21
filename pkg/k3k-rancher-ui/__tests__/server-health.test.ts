import {
  ETCD_FINALIZER, STUCK_AFTER_MS, isStuckTerminating, parseQuantity, serverHealth, serverPods, serverPvcName,
  validateExpansion, withoutEtcdFinalizer, hasServerSpread, setServerSpread
} from '../utils/server-health';

const NOW = Date.parse('2026-11-21T12:00:00Z');

type PodOpts = { deletedAt?: string; node?: string; ready?: boolean; running?: boolean };
type Named = { metadata: { name: string } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Spec = Record<string, any>;
type Health = { warnings: { id: string; pods?: string[] }[]; ready: number };

const cluster = { metadata: { name: 'authentik', namespace: 'k3k' }, spec: { servers: 3, persistence: { type: 'dynamic' } } };

function pod(n: number, opts: PodOpts = {}) {
  return {
    metadata: {
      name:              `k3k-authentik-server-${ n }`,
      namespace:         'k3k',
      finalizers:        [ETCD_FINALIZER],
      deletionTimestamp: opts.deletedAt,
      ownerReferences:   [{ kind: 'StatefulSet', name: 'k3k-authentik-server' }],
    },
    spec:   { nodeName: opts.node || `harvester0${ n + 1 }` },
    status: {
      conditions:        [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
      containerStatuses: [{ restartCount: 0, state: opts.running === false ? { terminated: {} } : { running: {} } }],
    },
  };
}

function pvc(n: number, size = '10Gi') {
  return { metadata: { name: serverPvcName('authentik', n), namespace: 'k3k' }, status: { capacity: { storage: size } } };
}

describe('serverPods', () => {
  it('selects only this cluster\'s server pods, ordered by ordinal', () => {
    const other = { metadata: { name: 'k3k-arc-server-0', namespace: 'k3k' } };
    const kubelet = { metadata: { name: 'k3k-authentik-kubelet-abcde', namespace: 'k3k' } };

    expect(serverPods([pod(2), other, kubelet, pod(0)], cluster).map((p: Named) => p.metadata.name))
      .toStrictEqual(['k3k-authentik-server-0', 'k3k-authentik-server-2']);
  });
});

describe('isStuckTerminating', () => {
  it('flags old deleted pods held by the etcd finalizer with nothing running', () => {
    const deletedAt = new Date(NOW - STUCK_AFTER_MS - 1).toISOString();

    expect(isStuckTerminating(pod(0, { deletedAt, running: false }), NOW)).toBe(true);
  });

  it('ignores pods that are still shutting down or just deleted', () => {
    expect(isStuckTerminating(pod(0, { deletedAt: new Date(NOW - 1000).toISOString(), running: false }), NOW)).toBe(false);
    expect(isStuckTerminating(pod(0, { deletedAt: new Date(NOW - 3600e3).toISOString() }), NOW)).toBe(false);
    expect(isStuckTerminating(pod(0), NOW)).toBe(false);
  });

  it('removes only the etcd finalizer', () => {
    expect(withoutEtcdFinalizer(['a', ETCD_FINALIZER, 'b'])).toStrictEqual(['a', 'b']);
  });
});

describe('parseQuantity', () => {
  it('handles binary and decimal suffixes', () => {
    expect(parseQuantity('2G')).toBe(2e9);
    expect(parseQuantity('1908Mi')).toBe(1908 * 1024 ** 2);
    expect(parseQuantity('5Gi')).toBe(5 * 1024 ** 3);
    expect(parseQuantity('nope')).toBeNaN();
  });
});

describe('serverHealth', () => {
  const ids = (h: Health) => h.warnings.map((w) => w.id);

  it('is quiet for a healthy, spread-out cluster', () => {
    const h = serverHealth(cluster, [pod(0), pod(1), pod(2)], [pvc(0), pvc(1), pvc(2)], NOW);

    expect(h.warnings).toStrictEqual([]);
    expect(h.ready).toBe(3);
  });

  it('reports stuck pods and lost quorum (all servers deleted during a drain)', () => {
    const deletedAt = new Date(NOW - 3600e3).toISOString();
    const pods = [0, 1, 2].map((n) => pod(n, {
      deletedAt, running: false, ready: false
    }));
    const h = serverHealth(cluster, pods, [pvc(0), pvc(1), pvc(2)], NOW);

    expect(ids(h)).toStrictEqual(['stuck', 'no-quorum']);
    expect(h.warnings[0].pods).toHaveLength(3);
  });

  it('warns when one node holds a quorum of servers', () => {
    const h = serverHealth(cluster, [pod(0, { node: 'harvester03' }), pod(1), pod(2, { node: 'harvester03' })], [pvc(0), pvc(1), pvc(2)], NOW);

    expect(ids(h)).toStrictEqual(['colocated-harvester03']);
  });

  it('warns about degraded clusters and small volumes', () => {
    const h = serverHealth(cluster, [pod(0), pod(1, { ready: false }), pod(2)], [pvc(0, '1908Mi'), pvc(1), pvc(2)], NOW);

    expect(ids(h)).toStrictEqual(['degraded', 'small-volumes']);
  });
});

describe('validateExpansion', () => {
  it('requires a valid size larger than every volume', () => {
    expect(validateExpansion('5Gi', [pvc(0, '1908Mi')])).toBeNull();
    expect(validateExpansion('1Gi', [pvc(0, '1908Mi')])).toMatch(/larger/);
    expect(validateExpansion('lots', [])).toMatch(/not a valid/);
  });
});

describe('server spread', () => {
  it('adds and removes only its own anti-affinity term', () => {
    const other = { topologyKey: 'topology.kubernetes.io/zone', labelSelector: { matchLabels: { app: 'x' } } };
    const spec: Spec = { serverAffinity: { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [other] } } };

    setServerSpread(spec, 'arc', true);
    setServerSpread(spec, 'arc', true);
    expect(hasServerSpread(spec, 'arc')).toBe(true);
    expect(hasServerSpread(spec, 'authentik')).toBe(false);
    expect(spec.serverAffinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution).toHaveLength(2);

    setServerSpread(spec, 'arc', false);
    expect(spec.serverAffinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution).toStrictEqual([other]);
  });

  it('cleans up empty affinity objects', () => {
    const spec: Spec = {};

    setServerSpread(spec, 'arc', true);
    expect(spec.serverAffinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector.matchLabels)
      .toStrictEqual({ cluster: 'arc', role: 'server' });
    setServerSpread(spec, 'arc', false);
    expect(spec).toStrictEqual({});
  });
});
