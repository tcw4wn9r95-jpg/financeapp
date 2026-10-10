import type { AccountType, CategoryGroup, RolloverMode } from '../domain/types';
import { t } from '../i18n';

export const groupLabel = (g: CategoryGroup) => t(`group.${g}`);
export const rolloverLabel = (m: RolloverMode) => t(`rollover.${m}`);
export const rolloverHelp = (m: RolloverMode) => t(`rollover.${m}.help`);
export const accountTypeLabel = (a: AccountType) => t(`accountType.${a}`);
