import {SELF} from 'cloudflare:test';
import {describe, expect, it} from 'vitest';

describe('install.sh', () => {
  it('serves the installer as a shell script', async () => {
    const response = await SELF.fetch('https://cantor.test/install.sh');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/x-shellscript; charset=utf-8',
    );

    const script = await response.text();
    expect(script.startsWith('#!/bin/sh')).toBe(true);
    // The published command pipes this into `sh -c "$(…)"`, so a truncated or
    // HTML-ified response has to fail loudly here rather than on someone's VPS.
    expect(script).toContain('Installed cantor at');
  });

  it('rejects methods that are not a read', async () => {
    const response = await SELF.fetch('https://cantor.test/install.sh', {
      method: 'POST',
    });

    expect(response.status).toBe(405);
  });

  it('still 404s unknown paths', async () => {
    const response = await SELF.fetch('https://cantor.test/nope');

    expect(response.status).toBe(404);
  });
});
