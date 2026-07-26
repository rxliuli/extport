-- Per-target reconcile lock — see runReconciliation's doc comment for the
-- four concurrent entry points this guards against.
ALTER TABLE `publish_targets` ADD `reconciling_since` text;