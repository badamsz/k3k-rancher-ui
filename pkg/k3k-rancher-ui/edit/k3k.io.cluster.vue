<script>
import CreateEditView from '@shell/mixins/create-edit-view';
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { RadioGroup } from '@components/Form/Radio';
import { Banner } from '@components/Banner';
import { STORAGE_CLASS } from '@shell/config/types';
import { MODES, PERSISTENCE_TYPES, EXPOSE_TYPES } from '../types';

export default {
  name:         'EditK3kCluster',
  inheritAttrs: false,

  components: {
    CruResource, NameNsDescription, LabeledSelect, LabeledInput, RadioGroup, Banner
  },

  mixins: [CreateEditView],

  async fetch() {
    try {
      const classes = await this.$store.dispatch('cluster/findAll', { type: STORAGE_CLASS });

      this.storageClasses = classes.map((sc) => sc.metadata.name);
    } catch (e) {
      this.storageClasses = [];
    }
  },

  data() {
    const v = this.value;

    v.spec = v.spec || {};
    v.spec.mode = v.spec.mode || 'shared';
    v.spec.servers = v.spec.servers ?? 1;
    v.spec.agents = v.spec.agents ?? 0;
    v.spec.persistence = v.spec.persistence || { type: 'dynamic' };

    let exposeType = 'none';

    if (v.spec.expose?.loadBalancer) {
      exposeType = 'loadBalancer';
    } else if (v.spec.expose?.nodePort) {
      exposeType = 'nodePort';
    } else if (v.spec.expose?.ingress) {
      exposeType = 'ingress';
    }

    return {
      storageClasses:     [],
      exposeType,
      modeOptions:        MODES,
      persistenceOptions: PERSISTENCE_TYPES,
      exposeOptions:      EXPOSE_TYPES.map((t) => ({ value: t, label: t === 'none' ? 'None (ClusterIP)' : t })),
    };
  },

  computed: {
    isVirtual() {
      return this.value.spec.mode === 'virtual';
    },

    isDynamic() {
      return this.value.spec.persistence?.type === 'dynamic';
    },

    // Mode, persistence and networking are immutable once the cluster exists
    lockedAfterCreate() {
      return this.isEdit || this.isView;
    },
  },

  watch: {
    exposeType(type) {
      if (type === 'none') {
        delete this.value.spec.expose;

        return;
      }
      this.value.spec.expose = { [type]: this.value.spec.expose?.[type] || {} };
    },
  },

  methods: {
    setInt(field, val) {
      const n = parseInt(val, 10);

      this.value.spec[field] = Number.isNaN(n) ? 0 : n;
    },

    setStorageClass(val) {
      if (val) {
        this.value.spec.persistence.storageClassName = val;
      } else {
        delete this.value.spec.persistence.storageClassName;
      }
    },

    setStorageSize(val) {
      if (val) {
        this.value.spec.persistence.storageRequestSize = val;
      } else {
        delete this.value.spec.persistence.storageRequestSize;
      }
    },
  },
};
</script>

<template>
  <CruResource
    :done-route="doneRoute"
    :mode="mode"
    :resource="value"
    :subtypes="[]"
    :errors="errors"
    @error="e=>errors = e"
    @finish="save"
    @cancel="done"
  >
    <NameNsDescription
      :value="value"
      :mode="mode"
      :register-before-hook="registerBeforeHook"
    />

    <h3>Mode</h3>
    <div class="row mb-10">
      <div class="col span-12">
        <RadioGroup
          v-model:value="value.spec.mode"
          name="mode"
          :options="modeOptions"
          :labels="['Shared', 'Virtual']"
          :mode="mode"
          :disabled="lockedAfterCreate"
        />
      </div>
    </div>
    <Banner
      v-if="isVirtual && !isView"
      color="warning"
      label="Virtual mode runs k3s agent pods privileged on the host nodes. A privileged pod inside the virtual cluster is effectively privileged on the host."
    />

    <h3>Nodes</h3>
    <div class="row mb-20">
      <div class="col span-3">
        <LabeledInput
          :value="value.spec.servers"
          type="number"
          min="1"
          label="Servers"
          :mode="mode"
          @update:value="v => setInt('servers', v)"
        />
      </div>
      <div
        v-if="isVirtual"
        class="col span-3"
      >
        <LabeledInput
          :value="value.spec.agents"
          type="number"
          min="0"
          label="Agents"
          :mode="mode"
          @update:value="v => setInt('agents', v)"
        />
      </div>
      <div class="col span-6">
        <LabeledInput
          v-model:value="value.spec.version"
          label="K3s version"
          placeholder="Defaults to the host cluster version, e.g. v1.33.4-k3s1"
          :mode="mode"
        />
      </div>
    </div>

    <h3>Storage</h3>
    <div class="row mb-20">
      <div class="col span-3">
        <LabeledSelect
          v-model:value="value.spec.persistence.type"
          label="Persistence"
          :options="persistenceOptions"
          :mode="mode"
          :disabled="lockedAfterCreate"
        />
      </div>
      <template v-if="isDynamic">
        <div class="col span-5">
          <LabeledSelect
            :value="value.spec.persistence.storageClassName"
            label="Storage class"
            placeholder="Host default"
            :options="storageClasses"
            :clearable="true"
            :mode="mode"
            :disabled="lockedAfterCreate"
            @update:value="setStorageClass"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            :value="value.spec.persistence.storageRequestSize"
            label="Size"
            placeholder="e.g. 10Gi"
            :mode="mode"
            :disabled="lockedAfterCreate"
            @update:value="setStorageSize"
          />
        </div>
      </template>
    </div>

    <h3>API server exposure</h3>
    <div class="row mb-20">
      <div class="col span-4">
        <LabeledSelect
          v-model:value="exposeType"
          label="Expose via"
          :options="exposeOptions"
          :mode="mode"
        />
      </div>
      <div
        v-if="exposeType === 'ingress'"
        class="col span-4"
      >
        <LabeledInput
          v-model:value="value.spec.expose.ingress.ingressClassName"
          label="Ingress class"
          :mode="mode"
        />
      </div>
    </div>
  </CruResource>
</template>
