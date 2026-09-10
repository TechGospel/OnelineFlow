import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMoney } from './review-ui.js';

describe('HTML escaping', () => {
  // Vendor names and line descriptions come from PDFs supplied by third
  // parties. This is exactly where an injection would arrive.
  it('neutralises a script tag in a vendor name', () => {
    const escaped = escapeHtml('<script>alert(1)</script>');
    expect(escaped).not.toContain('<script');
    expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes quotes so an attribute cannot be broken out of', () => {
    // The invoice id and version are rendered into value="..." attributes.
    expect(escapeHtml('" onload="alert(1)')).toBe('&quot; onload=&quot;alert(1)');
    expect(escapeHtml("' onerror='x")).toBe('&#39; onerror=&#39;x');
  });

  it('escapes ampersands first so escaping is not double-applied', () => {
    // If & were escaped last, "&lt;" would become "&amp;lt;" — visible
    // corruption in the UI and a sign the ordering is wrong.
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('renders null and undefined as empty, not as the words', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('leaves ordinary vendor names untouched', () => {
    expect(escapeHtml('Acme Ltd')).toBe('Acme Ltd');
    expect(escapeHtml('Café Ürgen GmbH')).toBe('Café Ürgen GmbH');
  });

  it('escapes a javascript: URL attempt', () => {
    expect(escapeHtml('javascript:alert(1)')).not.toContain('<');
  });
});

describe('money rendering', () => {
  // The UI must never parse an amount into a float. These assert the exact
  // string a reviewer sees before approving a payment.
  it('renders a two-decimal currency', () => {
    expect(renderMoney(123456n, 'USD')).toBe('1234.56 USD');
  });

  it('renders a zero-decimal currency without a decimal point', () => {
    expect(renderMoney(150000n, 'JPY')).toBe('150000 JPY');
  });

  it('pads sub-unit amounts correctly', () => {
    expect(renderMoney(5n, 'USD')).toBe('0.05 USD');
    expect(renderMoney(50n, 'USD')).toBe('0.50 USD');
    expect(renderMoney(0n, 'USD')).toBe('0.00 USD');
  });

  it('renders a credit note as negative', () => {
    expect(renderMoney(-4250n, 'EUR')).toBe('-42.50 EUR');
  });

  it('handles an amount beyond Number.MAX_SAFE_INTEGER', () => {
    // A float would silently lose precision here; the reviewer would approve a
    // different number from the one stored.
    expect(renderMoney(9007199254740993n, 'USD')).toBe('90071992547409.93 USD');
  });

  it('accepts a string amount from the database driver', () => {
    expect(renderMoney('123456', 'GBP')).toBe('1234.56 GBP');
  });

  it('renders an em dash when there is no amount yet', () => {
    expect(renderMoney(null, 'USD')).toBe('—');
    expect(renderMoney(123n, null)).toBe('—');
  });
});
