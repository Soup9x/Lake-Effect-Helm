/**
 * The options page: the same settings the popup shows (settings.ts), on a
 * page of their own, for whoever opens them from the browser's extensions
 * list.
 */
import { mountSettings } from './settings';
import { applyRememberedTheme } from './theme';

applyRememberedTheme();
mountSettings(document.getElementById('settings')!);
