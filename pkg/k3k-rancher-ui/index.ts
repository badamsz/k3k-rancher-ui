import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import models/, edit/, detail/ and l10n/ by resource type name
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  // "Virtual Clusters" product, shown on any cluster that has the k3k CRDs
  plugin.addProduct(require('./product'));
}
