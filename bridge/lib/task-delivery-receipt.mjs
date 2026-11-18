const normalized = (status, details) => status === 'delivered' ? (details.messageId ? 'wechat_accepted' : 'unknown')
  : status === 'suspect-dropped' ? 'unknown' : status;

export function reduceTaskDelivery(delivery = {}, item = {}, status, details = {}) {
  status = normalized(status, details);
  const receipt = { ...details, ...(item.clientId ? { clientId: item.clientId } : {}), requestPending: details.requestPending === true };
  if (!item.taskPartCount || item.taskPartCount === 1 || item.taskPartIndex == null) {
    const previous = { ...delivery }; delete previous.status;
    if (delivery.status === 'wechat_accepted' && status !== 'wechat_accepted') {
      return { status: delivery.status, details: { ...previous, requestPending: receipt.requestPending } };
    }
    return { status, details: receipt };
  }
  const count = item.taskPartCount, index = item.taskPartIndex;
  if (!Number.isInteger(count) || count < 2 || !Number.isInteger(index) || index < 0 || index >= count) throw new Error('任务分片索引无效');
  const parts = Array.from({ length: count }, (_, i) => ({ ...(delivery.parts?.[i] || { status: 'pending', requestPending: false }) }));
  const previous = parts[index];
  if (previous.status === 'wechat_accepted' || (previous.status === 'unknown' && status !== 'wechat_accepted')) {
    parts[index] = { ...previous, requestPending: receipt.requestPending };
  } else parts[index] = { ...receipt, status };
  const values = parts.map(part => part.status);
  const acceptedParts = values.filter(value => value === 'wechat_accepted').length;
  let aggregate;
  if (acceptedParts === count) aggregate = 'wechat_accepted';
  else if (values.includes('unknown') || values.includes('failed')) aggregate = 'unknown';
  else if (values.every(value => value === 'withdrawn')) aggregate = 'withdrawn';
  else if (values.every(value => ['wechat_accepted', 'withdrawn'].includes(value))) aggregate = 'partially_accepted';
  else if (values.includes('withdrawn')) aggregate = 'unknown';
  else aggregate = values[index] !== 'wechat_accepted' ? values[index]
    : ['retrying', 'deferred_window', 'deferred_quiet', 'deferred', 'queued', 'pending'].find(value => values.includes(value)) || 'pending';
  return { status: aggregate, details: { ...receipt, messageId: receipt.messageId || null, parts, partCount: count, acceptedParts,
    requestPending: parts.some(part => part.requestPending === true) } };
}
