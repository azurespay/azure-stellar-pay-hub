// k6 load test — run with: k6 run tests/load/payment-load.js
//
// Exercises the public health endpoint, the public asset list, and (when a
// TOKEN is supplied) the authenticated payment-simulate + history routes —
// the real routes the web app calls on every load. Kept read-only so the test
// never creates persistent state on a live stack; use the E2E suites for
// write-path coverage.
//
// Env:
//   API_URL   base URL (default http://localhost:4000)
//   TOKEN     optional JWT — enables the authenticated routes
//   VUS       virtual users (default 20)
import http from 'k6/http';
import { check, sleep } from 'k6';

const API_URL = __ENV.API_URL || 'http://localhost:4000';
const TOKEN = __ENV.TOKEN || '';

export const options = {
  stages: [
    { duration: '30s', target: __ENV.VUS || 20 }, // ramp up
    { duration: '1m', target: __ENV.VUS || 20 }, // steady
    { duration: '30s', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  // Public probes — what any anonymous visitor hits.
  const health = http.get(`${API_URL}/api/health`);
  check(health, {
    'health 200': (r) => r.status === 200,
    'health ok body': (r) => {
      try {
        return r.json().status === 'ok';
      } catch (e) {
        return false;
      }
    },
  });

  const assets = http.get(`${API_URL}/api/assets`);
  check(assets, { 'assets 200': (r) => r.status === 200 });

  // Authenticated read routes (the dashboard/history pages).
  if (TOKEN) {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    };
    const simulate = http.post(
      `${API_URL}/api/payments/simulate`,
      JSON.stringify({
        type: 'SEND',
        fromPublicKey: 'GDRSWHX6IQGJJG2YZWHZ7PZR4OHKXZKHVW2QKJWXVFFDSM47WZW77J3Y',
        destinations: [
          { publicKey: 'GDQI7WDWNGXCNL2DNFLQW5O5VBMUKP5TY2A7JQV5X6Z5XQ5B4ZGKGLYM', amount: '1' },
        ],
        assetCode: 'XLM',
        assetIssuer: null,
      }),
      { headers },
    );
    check(simulate, { 'simulate 200|201': (r) => r.status === 200 || r.status === 201 });

    const history = http.get(`${API_URL}/api/payments/history?page=1&pageSize=10`, { headers });
    check(history, { 'history 200': (r) => r.status === 200 });
  }

  // Small think-time to approximate real user pacing without hammering.
  sleep(0.2);
}
