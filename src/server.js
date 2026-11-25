'use strict';
// Local / self-hosted entry point. On Vercel, api/index.js is used instead.
const { createApp } = require('./app');

const port = Number(process.env.PORT || 3000);
createApp().listen(port, () => console.log(`Vanagopal Kanakku running on http://localhost:${port}`));
