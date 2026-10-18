const { safeWebsiteURL, searchedURLs } = require('./website-search');

const destinationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    destinations: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' }, region: { type: 'string' },
          reason: { type: 'string' }, seasonalHighlight: { type: 'string' },
          travelHint: { type: 'string' }, highlights: { type: 'array', items: { type: 'string' } },
          sourceTitle: { type: 'string' }, url: { type: 'string' },
        },
        required: ['name', 'region', 'reason', 'seasonalHighlight', 'travelHint', 'highlights', 'sourceTitle', 'url'],
      },
    },
  },
  required: ['destinations'],
};

function verifiedDestinations(response) {
  const output = (response.output || []).filter(item => item.type === 'message')
    .flatMap(item => item.content || []).filter(item => item.type === 'output_text')
    .map(item => item.text).join('');
  const result = JSON.parse(output);
  if (!Array.isArray(result.destinations)) throw new Error('invalid_destinations');
  const sources = searchedURLs(response), seen = new Set(), destinations = [];
  for (const candidate of result.destinations) {
    if (!candidate || ['name', 'region', 'reason', 'seasonalHighlight', 'travelHint', 'sourceTitle']
      .some(key => typeof candidate[key] !== 'string' || !candidate[key].trim() || candidate[key].length > (key === 'name' ? 80 : 240))) continue;
    const url = safeWebsiteURL(candidate.url);
    if (!url || !sources.has(url)) continue;
    if (!Array.isArray(candidate.highlights) || candidate.highlights.length < 1 || candidate.highlights.length > 3
      || candidate.highlights.some(value => typeof value !== 'string' || !value.trim() || value.length > 80)) continue;
    const name = candidate.name.trim(), key = name.normalize('NFKC').toLocaleLowerCase('ja');
    if (seen.has(key)) continue;
    seen.add(key);
    destinations.push({ ...candidate, name, url });
    if (destinations.length === 3) break;
  }
  if (!destinations.length) throw new Error('no_verified_destinations');
  return destinations;
}

module.exports = { destinationSchema, verifiedDestinations };
