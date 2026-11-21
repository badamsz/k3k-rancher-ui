<script>
import { Banner } from '@components/Banner';
import Loading from '@shell/components/Loading';
import { POD, PVC } from '@shell/config/types';
import { serverHealth } from '../utils/server-health';

const BANNER_COLOR = {
  error: 'error', warning: 'warning', info: 'info'
};

export default {
  name: 'DetailK3kCluster',

  components: { Banner, Loading },

  props: {
    value: {
      type:     Object,
      required: true,
    },
    mode: {
      type:    String,
      default: 'view',
    },
  },

  async fetch() {
    const ns = this.value.metadata.namespace;

    // Live (watched) lists, so the panel updates as pods come and go
    const [pods, pvcs] = await Promise.all([
      this.$store.dispatch('cluster/findAll', { type: POD, opt: { namespaced: ns } }),
      this.$store.dispatch('cluster/findAll', { type: PVC, opt: { namespaced: ns } }),
    ]);

    this.pods = pods;
    this.pvcs = pvcs;
  },

  data() {
    return {
      pods: [], pvcs: [], now: Date.now(), timer: null
    };
  },

  mounted() {
    // "stuck" depends on how long a pod has been terminating
    this.timer = setInterval(() => {
      this.now = Date.now();
    }, 30000);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  computed: {
    health() {
      return serverHealth(this.value, this.pods, this.pvcs, this.now);
    },

    hasStuck() {
      return this.health.warnings.some((w) => w.id === 'stuck');
    },

    hasSmallVolumes() {
      return this.health.warnings.some((w) => w.id === 'small-volumes');
    },
  },

  methods: {
    bannerColor(level) {
      return BANNER_COLOR[level] || 'info';
    },

    serverState(s) {
      if (s.stuck) {
        return { label: 'Stuck terminating', cls: 'text-error' };
      }
      if (s.deleting) {
        return { label: 'Terminating', cls: 'text-warning' };
      }

      return s.ready ? { label: 'Ready', cls: 'text-success' } : { label: 'Not ready', cls: 'text-warning' };
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div v-else>
    <h3>Server health</h3>
    <p class="mb-10 text-muted">
      {{ health.ready }}/{{ health.desired }} servers ready.
      "Ready" here is the pod's readiness probe, which only checks that the API port is open;
      a server can be ready while etcd has no quorum.
    </p>

    <Banner
      v-for="w in health.warnings"
      :key="w.id"
      :color="bannerColor(w.level)"
      :label="w.message"
    />

    <div
      v-if="hasStuck || hasSmallVolumes"
      class="mb-20"
    >
      <button
        v-if="hasStuck"
        class="btn role-primary mr-10"
        type="button"
        @click="value.releaseStuckServers()"
      >
        Release stuck server pods
      </button>
      <button
        v-if="hasSmallVolumes"
        class="btn role-secondary"
        type="button"
        @click="value.expandServerVolumes()"
      >
        Expand server volumes
      </button>
    </div>

    <table
      v-if="health.servers.length"
      class="sortable-table mb-20"
      width="100%"
    >
      <thead>
        <tr>
          <th>Server pod</th>
          <th>State</th>
          <th>Host node</th>
          <th>Restarts</th>
          <th>Volume</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="s in health.servers"
          :key="s.name"
        >
          <td>{{ s.name }}</td>
          <td :class="serverState(s).cls">
            {{ serverState(s).label }}
          </td>
          <td>{{ s.node || '—' }}</td>
          <td>{{ s.restarts }}</td>
          <td>{{ s.volume || '—' }}</td>
        </tr>
      </tbody>
    </table>
    <p
      v-else
      class="text-muted"
    >
      No server pods found.
    </p>
  </div>
</template>
