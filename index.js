const url = require('url');
const https = require('https');
const { Storage } = require('@google-cloud/storage');
const config = require('./config.json');

function formatSlackMessage(report, date, services) {
  const fields = services.map(service => ({
    title: service.name,
    value: `${report.amounts[service.id] || 0} ${report.currency}`,
    short: true,
  }));
  const total = Object.values(report.amounts).reduce((current, base) => base + current, 0);
  fields.push({
    title: 'Others',
    value: `${total - services.reduce((base, service) => base + (report.amounts[service.id] || 0), 0)} ${report.currency}`,
    short: true,
  });
  fields.push({
    title: 'Total',
    value: `${total} ${report.currency}`,
    short: true,
  });
  return {
    attachments: [{
      title: formatDate(date, '/'),
      fields,
    }],
  };
};

function parseBillingReport(items) {
  if (items.length < 1) {
    return {};
  }

  const currency = items[0].cost.currency;
  const amounts = {};
  items.forEach(item => {
    if (item.cost.currency !== currency) {
      throw new Error(`Multiple currency not accepted: ${current}, ${item.cost.currency}`);
    }
    const service = item.lineItemId.split('/')[2];
    amounts[service] = (amounts[service] || 0) + Number(item.cost.amount);
  });
  return { currency, amounts };
}

function getDateToReport() {
  const TWO_DAYS = 24*60*60*1000*2;
  return new Date(Date.now() - TWO_DAYS);
}

function formatDate(date, separator) {
  return [date.getFullYear(), date.getMonth()+1, date.getDate()].join(separator);
}

function loadFromGCS(bucket, filename) {
  return new Promise((resolve, reject) => {
    const storage = new Storage();
    const stream = storage.bucket(bucket).file(filename).createReadStream();

    let data = '';
    stream.on('error', reject)
    stream.on('data', chunk => data += chunk);
    stream.on('end', () => resolve(JSON.parse(data)));
  });
}

function postToSlack(webhookURL, msg) {
  return new Promise((resolve, reject) => {
    const { hostname, path } = url.parse(webhookURL);
    const body = JSON.stringify(msg);
    const options = {
      method: 'POST',
      hostname, path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length.toString(),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('error', reject);
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);

    req.write(body);
    req.end();
  });
}

exports.reportGCPBilling = async (req, res) => {
  const date = getDateToReport();
  const json = await loadFromGCS(config.bucket, config.prefix + formatDate(date, '-') + '.json');
  const report = parseBillingReport(json);
  const msg = formatSlackMessage(report, date, config.services);
  const result = await postToSlack(config.slack_webhook_url, msg);
  res.status(200).send(result);
};
