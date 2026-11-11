import * as migration_20261109_001332_initial from './20261109_001332_initial';
import * as migration_20261111_112842_site_content_and_organisation from './20261111_112842_site_content_and_organisation';
import * as migration_20261111_190000_site_content_npp from './20261111_190000_site_content_npp';

export const migrations = [
  {
    up: migration_20261109_001332_initial.up,
    down: migration_20261109_001332_initial.down,
    name: '20261109_001332_initial',
  },
  {
    up: migration_20261111_112842_site_content_and_organisation.up,
    down: migration_20261111_112842_site_content_and_organisation.down,
    name: '20261111_112842_site_content_and_organisation',
  },
  {
    up: migration_20261111_190000_site_content_npp.up,
    down: migration_20261111_190000_site_content_npp.down,
    name: '20261111_190000_site_content_npp',
  },
];
