'use strict';
const { createApp } = require('./app');

const port = Number(process.env.PORT || 3000);
const app = createApp({
  dbFile: process.env.DB_FILE,
  secureCookies: process.env.SECURE_COOKIES === '1',
});
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.listen(port, () => console.log(`Vanagopal Kanakku running on http://localhost:${port}`));
