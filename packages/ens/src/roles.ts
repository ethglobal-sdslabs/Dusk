export const ROLE_REGISTRAR = 1n << 0n
export const ROLE_SET_PARENT = 1n << 8n
export const ROLE_UNREGISTER = 1n << 12n
export const ROLE_RENEW = 1n << 16n
export const ROLE_UPGRADE = 1n << 124n
const admin = (role: bigint) => role << 128n

export const CONTROLLER_ROLES = ROLE_REGISTRAR | ROLE_UNREGISTER | ROLE_RENEW

export const GOVERNANCE_ROLES =
  ROLE_SET_PARENT | admin(ROLE_SET_PARENT) | ROLE_UPGRADE | admin(ROLE_UPGRADE) |
  admin(ROLE_REGISTRAR) | admin(ROLE_UNREGISTER) | admin(ROLE_RENEW)
