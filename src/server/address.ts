import type { CustomTarget } from '../types.js';
import { ADDRESS_PATTERNS } from '../detect/address.js';

/**
 * The candidate's postal address. Unlike the built-in `address` target, a city,
 * state or country on its own is kept: companies need to know where a
 * candidate is, just not the street they live on.
 */
export const ADDRESS: CustomTarget = {
  id: 'address',
  description:
    "The candidate's street or postal address: house or flat number, street, locality, and PIN or postal code. Not a city, state or country on its own, and not an employer's or university's location.",
  patterns: ADDRESS_PATTERNS,
};
