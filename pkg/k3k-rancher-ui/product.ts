import { IPlugin } from '@shell/core/types';
import { PRODUCT_NAME, K3K } from './types';

export function init($plugin: IPlugin, store: unknown) {
  const {
    product, basicType, configureType, weightType
  } = $plugin.DSL(store, PRODUCT_NAME);

  // Only shown on clusters where the k3k CRDs are installed (e.g. the Harvester host)
  product({
    inStore:             'cluster',
    ifHaveType:          K3K.CLUSTER,
    icon:                'globe',
    label:               'Virtual Clusters',
    weight:              90,
    showNamespaceFilter: true,
  });

  basicType([K3K.CLUSTER, K3K.POLICY, K3K.SNAPSHOT]);

  weightType(K3K.CLUSTER, 3, true);
  weightType(K3K.POLICY, 2, true);
  weightType(K3K.SNAPSHOT, 1, true);

  configureType(K3K.CLUSTER, {
    isCreatable: true,
    isEditable:  true,
    isRemovable: true,
    showAge:     true,
    showState:   true,
    canYaml:     true,
  });
}
