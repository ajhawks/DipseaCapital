import type { OrderFields, ValidationIssue } from '@silexx/shared';

/**
 * Required fields, blocking errors vs. warnings, and configured sanity checks (S1.3).
 * Never modifies the order: it only reports. Sanity checks are inactive unless
 * configured (D7: no invented limits), and an inactive check produces no output.
 */

export interface SanityConfig {
  maxQuantity?: number;
  maxNotional?: number;
}

export function sanityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SanityConfig {
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const config: SanityConfig = {};
  const maxQuantity = num(env['SANITY_MAX_QUANTITY']);
  const maxNotional = num(env['SANITY_MAX_NOTIONAL']);
  if (maxQuantity !== undefined) config.maxQuantity = maxQuantity;
  if (maxNotional !== undefined) config.maxNotional = maxNotional;
  return config;
}

const SYMBOL_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;
const isPositive = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0;

export function validateOrder(order: OrderFields, config: SanityConfig = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, field?: keyof OrderFields) =>
    issues.push({ code, severity: 'error', message, ...(field ? { field } : {}) });
  const warn = (code: string, message: string, field?: keyof OrderFields) =>
    issues.push({ code, severity: 'warning', message, ...(field ? { field } : {}) });

  if (order.assetClass === 'OPTION') {
    error('OPTIONS_UNSUPPORTED', 'Options orders are not supported yet.', 'assetClass');
    return issues;
  }

  if (order.side !== 'BUY' && order.side !== 'SELL') error('SIDE_REQUIRED', 'Side must be BUY or SELL.', 'side');
  if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
    error('QUANTITY_INVALID', 'Quantity must be a whole number greater than zero.', 'quantity');
  }
  if (!SYMBOL_RE.test(order.symbol)) error('SYMBOL_INVALID', `"${order.symbol}" is not a valid ticker.`, 'symbol');

  const hasLimit = order.limitPrice !== undefined;
  const hasStop = order.stopPrice !== undefined;
  switch (order.orderType) {
    case 'MARKET':
      if (hasLimit) error('PRICE_NOT_ALLOWED', 'A market order cannot have a limit price.', 'limitPrice');
      if (hasStop) error('PRICE_NOT_ALLOWED', 'A market order cannot have a stop price.', 'stopPrice');
      break;
    case 'LIMIT':
      if (!isPositive(order.limitPrice)) error('LIMIT_PRICE_REQUIRED', 'A limit order needs a limit price above zero.', 'limitPrice');
      if (hasStop) error('PRICE_NOT_ALLOWED', 'A limit order cannot have a stop price. Use stop-limit.', 'stopPrice');
      break;
    case 'STOP':
      if (!isPositive(order.stopPrice)) error('STOP_PRICE_REQUIRED', 'A stop order needs a stop price above zero.', 'stopPrice');
      if (hasLimit) error('PRICE_NOT_ALLOWED', 'A stop-market order cannot have a limit price. Use stop-limit.', 'limitPrice');
      break;
    case 'STOP_LIMIT':
      if (!isPositive(order.stopPrice)) error('STOP_PRICE_REQUIRED', 'A stop-limit order needs a stop price above zero.', 'stopPrice');
      if (!isPositive(order.limitPrice)) error('LIMIT_PRICE_REQUIRED', 'A stop-limit order needs a limit price above zero.', 'limitPrice');
      break;
    default:
      error('ORDER_TYPE_INVALID', 'Unknown order type.', 'orderType');
  }

  if (config.maxQuantity !== undefined && order.quantity > config.maxQuantity) {
    warn(
      'QUANTITY_ABOVE_MAX',
      `Quantity ${order.quantity.toLocaleString()} is above the configured maximum of ${config.maxQuantity.toLocaleString()}.`,
      'quantity',
    );
  }

  if (config.maxNotional !== undefined) {
    // Use the order's own price; there is no market-data source yet, so a market
    // order's notional can't be checked. Disclose that instead of passing it.
    const price = order.orderType === 'STOP' ? order.stopPrice : order.limitPrice;
    if (price === undefined) {
      warn('NOTIONAL_UNCHECKED', 'Notional limit could not be checked: no price on this order and no reference price is available.');
    } else if (price * order.quantity > config.maxNotional) {
      warn(
        'NOTIONAL_ABOVE_MAX',
        `Notional of about $${(price * order.quantity).toLocaleString()} is above the configured maximum of $${config.maxNotional.toLocaleString()}.`,
      );
    }
  }

  return issues;
}

export const hasBlockingErrors = (issues: readonly ValidationIssue[]): boolean =>
  issues.some((i) => i.severity === 'error');

export const warningCodes = (issues: readonly ValidationIssue[]): string[] =>
  issues.filter((i) => i.severity === 'warning').map((i) => i.code);
