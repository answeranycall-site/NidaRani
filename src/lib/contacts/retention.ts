/**
 * Shared (non-server) constant for the soft-delete grace period. A
 * "deleted" contact (see Contact.deletedAt) stays fully intact and
 * restorable for this many days before the daily purge cron
 * (api/cron/purge-deleted-contacts) permanently removes it.
 */
export const DELETED_CONTACT_RETENTION_DAYS = 7;
