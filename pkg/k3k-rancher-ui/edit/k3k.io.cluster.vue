<script>
import CreateEditView from '@shell/mixins/create-edit-view';
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { RadioGroup } from '@components/Form/Radio';
import { Banner } from '@components/Banner';
import { Checkbox } from '@components/Form/Checkbox';
import { STORAGE_CLASS, MANAGEMENT } from '@shell/config/types';
import {
  MODES, PERSISTENCE_TYPES, EXPOSE_TYPES, K3S_IMAGE_TAG, normalizeK3sVersion, toReleaseName
} from '../types';
import { getAllOptionsAfterCurrentVersion, filterOutDeprecatedPatchVersions } from '@shell/utils/cluster';
import sortBy from 'lodash/sortBy';
import impl from '@shell/mixins/create-edit-view/impl';
import { ANNOTATIONS, defaultRancherName, prepareRancherImport } from '../utils/rancher-import';

export default {
  name:         'EditK3kCluster',
  inheritAttrs: false,

  components: {
    CruResource, NameNsDescription, LabeledSelect, LabeledInput, RadioGroup, Banner, Checkbox
  },

  mixins: [CreateEditView],

  async fetch() {
    // K3s releases Rancher supports (same KDM data as Cluster Management's version dropdown)
    try {
      const [releases, defaultSetting] = await Promise.all([
        this.$store.dispatch('management/request', { url: '/v1-k3s-release/releases' }),
        this.$store.dispatch('management/find', { type: MANAGEMENT.SETTING, id: 'k3s-default-version' }).catch(() => null),
      ]);

      this.k3sReleases = releases?.data || [];
      this.defaultK3s = defaultSetting?.value || defaultSetting?.default || '';
    } catch (e) {
      this.k3sReleases = [];
    }

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
      k3sReleases:        null,
      defaultK3s:         '',
      showDeprecated:     false,
      importIntoRancher:  this.mode === 'create',
      rancherName:        '',
      createdProvCluster: null,
      storageClasses:     [],
      exposeType,
      modeOptions:        MODES,
      persistenceOptions: PERSISTENCE_TYPES,
      exposeOptions:      EXPOSE_TYPES.map((t) => ({ value: t, label: t === 'none' ? 'None (ClusterIP)' : t })),
    };
  },

  created() {
    this.registerBeforeHook(this.normalizeVersion, 'normalizeVersion', 100);
    // Run after NameNsDescription's hooks (which may create the namespace)
    this.registerBeforeHook(this.doRancherImport, 'rancherImport', 200);
  },

  computed: {
    // Version the cluster runs today, in Rancher's release-name form
    currentRelease() {
      if (this.isCreate) {
        return null;
      }

      return toReleaseName(this.initialValue?.spec?.version) || null;
    },

    hostVersionLabel() {
      const host = this.value.status?.hostVersion;

      return host ? `Match host cluster (${ host })` : 'Match host cluster';
    },

    versionOptions() {
      let opts = getAllOptionsAfterCurrentVersion(this.$store, this.k3sReleases || [], this.currentRelease, this.defaultK3s);

      if (!this.showDeprecated) {
        opts = filterOutDeprecatedPatchVersions(opts, this.currentRelease);
      }

      opts = sortBy(opts, 'sort').reverse();

      // A version typed by hand or no longer offered by Rancher stays selectable
      const selected = this.selectedRelease;

      if (selected && !opts.find((o) => o.value === selected)) {
        opts.unshift({ label: selected, value: selected });
      }

      return [{ label: this.hostVersionLabel, value: '' }, ...opts];
    },

    hasReleaseList() {
      return !!this.k3sReleases?.length;
    },

    selectedRelease: {
      get() {
        return toReleaseName(this.value.spec.version);
      },
      set(release) {
        if (release) {
          this.value.spec.version = normalizeK3sVersion(release);
        } else {
          delete this.value.spec.version;
        }
      },
    },

    linkedRancherCluster() {
      return this.value.metadata?.annotations?.[ANNOTATIONS.RANCHER_CLUSTER];
    },

    rancherNamePlaceholder() {
      return defaultRancherName(this.value.metadata?.name) || 'Defaults to the cluster name';
    },

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
    // k3k uses spec.version as the image tag; "+" (as in K3s release names) is invalid there
    normalizeVersion() {
      const v = normalizeK3sVersion(this.value.spec.version);

      if (!v) {
        delete this.value.spec.version;

        return;
      }

      if (!K3S_IMAGE_TAG.test(v)) {
        throw new Error(`K3s version "${ this.value.spec.version }" is not a valid rancher/k3s image tag (expected e.g. v1.36.5-k3s1)`);
      }

      this.value.spec.version = v;
    },

    async doRancherImport() {
      if (!this.isCreate || !this.importIntoRancher) {
        return;
      }

      const rancherName = defaultRancherName(this.rancherName || this.value.metadata.name);

      this.createdProvCluster = await prepareRancherImport(
        (action, payload) => this.$store.dispatch(action, payload),
        this.value,
        { rancherName, hostClusterId: this.$store.getters['currentCluster']?.id }
      );
    },

    // If creating the k3k Cluster fails, remove the Rancher cluster we just made
    async actuallySave(url) {
      try {
        return await impl.methods.actuallySave.call(this, url);
      } catch (err) {
        if (this.createdProvCluster) {
          await this.createdProvCluster.remove().catch(() => {});
          this.createdProvCluster = null;
        }
        throw err;
      }
    },

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
        <template v-if="hasReleaseList">
          <LabeledSelect
            v-model:value="selectedRelease"
            label="K3s version"
            :options="versionOptions"
            :mode="mode"
          />
          <Checkbox
            v-if="!isView"
            v-model:value="showDeprecated"
            class="mt-5"
            label="Show deprecated patch versions"
            :mode="mode"
          />
        </template>
        <LabeledInput
          v-else
          v-model:value="value.spec.version"
          label="K3s version"
          placeholder="Blank = host version. e.g. v1.36.5-k3s1 ('+' is converted to '-')"
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

    <h3>Rancher</h3>
    <div
      v-if="isCreate"
      class="row mb-20"
    >
      <div class="col span-4">
        <Checkbox
          v-model:value="importIntoRancher"
          label="Import into Rancher"
          :mode="mode"
        />
      </div>
      <div
        v-if="importIntoRancher"
        class="col span-6"
      >
        <LabeledInput
          v-model:value="rancherName"
          label="Rancher cluster name"
          :placeholder="rancherNamePlaceholder"
          :mode="mode"
        />
      </div>
    </div>
    <p
      v-else-if="linkedRancherCluster"
      class="mb-20"
    >
      Imported into Rancher as <code>{{ linkedRancherCluster }}</code>.
    </p>
    <p
      v-else
      class="mb-20 text-muted"
    >
      Not imported. Use the <b>Import into Rancher</b> action on the cluster list.
    </p>
  </CruResource>
</template>
