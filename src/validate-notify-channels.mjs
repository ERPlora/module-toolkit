// Publish guard for the `host.notify` channels a module declares (ERPlora/hub#689).
//
// ADR-0012 lists three channels and the JSON Schema accepts all three, but only two of them have a
// transport: the SaaS proxies email and whatsapp (ADR-0283 §5) and the hub keeps no sms credential
// of its own — `Channel::Sms` returns an explicit error at send time
// (`crates/server/src/notify_transport.rs`). The runtime is loud, but it is loud in PRODUCTION:
// until this guard `erplora validate` did not read `notify` at all, so a manifest declaring `sms`
// packed, signed and published green and failed the first time a real hub notified a real customer.
//
// The check keys on a POSITIVE list of channels that have a transport rather than on a blacklist of
// one: when the SaaS proxies sms, a single entry moves and the guard stays correct — and a channel
// nobody implements (`telegram`) is caught by the same code path instead of slipping through.
//
// This is an ERROR, not a warning: no published module declares a channel without transport today
// (hub#689), so nothing breaks, and a module that declares one cannot work.

/** Channels with a real transport behind them (SaaS device endpoints, saas#1353). */
export const SUPPORTED_NOTIFY_CHANNELS = ['email', 'whatsapp'];

/**
 * Channels the contract advertises (ADR-0012 / `module.schema.json`) that have no transport yet.
 * They get their own message: the author did not invent them, we did — telling them "unknown
 * channel" would send them looking for a typo that is not there.
 */
export const CHANNELS_WITHOUT_TRANSPORT = ['sms'];

/** Where a channel can be declared: the ADR-0012 legacy block and the consolidated capability. */
const CHANNEL_PATHS = [
  ['notify.channels', (m) => m?.notify?.channels],
  ['capabilities.notify.channels', (m) => m?.capabilities?.notify?.channels],
];

/**
 * Validates the notification channels a manifest declares. Returns the list of errors (empty = ok).
 *
 * Shape is NOT this function's job — the JSON Schema owns it — so anything that is not an array of
 * strings is ignored rather than reported twice in two different vocabularies.
 */
export function checkNotifyChannels(manifest) {
  /** channel → the declaration paths that mention it (a channel may be declared through both). */
  const declared = new Map();
  for (const [path, read] of CHANNEL_PATHS) {
    const channels = read(manifest);
    if (!Array.isArray(channels)) continue;
    for (const channel of channels) {
      if (typeof channel !== 'string') continue;
      if (!declared.has(channel)) declared.set(channel, []);
      if (!declared.get(channel).includes(path)) declared.get(channel).push(path);
    }
  }

  const errs = [];
  for (const [channel, paths] of declared) {
    if (SUPPORTED_NOTIFY_CHANNELS.includes(channel)) continue;
    const where = paths.join(' + ');
    if (CHANNELS_WITHOUT_TRANSPORT.includes(channel)) {
      errs.push(
        `${where}: el canal \`${channel}\` NO tiene transporte (hub#689). El contrato lo anuncia ` +
          `(ADR-0012) y el schema lo admite, pero el SaaS solo hace de proxy de ` +
          `${SUPPORTED_NOTIFY_CHANNELS.join(' y ')} (ADR-0283 §5) y el hub no guarda credencial ` +
          `propia: en cuanto el módulo notifique, el runtime devuelve error y el aviso NO sale. ` +
          `Usa ${SUPPORTED_NOTIFY_CHANNELS.map((c) => `\`${c}\``).join('/')} mientras tanto.`,
      );
    } else {
      errs.push(
        `${where}: canal desconocido \`${channel}\` (hub#689). Los canales con transporte son ` +
          `${SUPPORTED_NOTIFY_CHANNELS.map((c) => `\`${c}\``).join(', ')}; el conjunto es CERRADO ` +
          `(añadir uno = tocar el runtime, ADR-0012), así que un nombre que no esté en la lista no ` +
          `lo entrega nadie.`,
      );
    }
  }
  return errs;
}
