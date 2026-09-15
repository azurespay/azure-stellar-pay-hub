import { render, screen } from '@testing-library/react';
import NavSidebar from './_nav-sidebar';

const NAV: Array<[label: string, href: string]> = [
  ['Overview', '/'],
  ['Users', '/users'],
  ['Merchants', '/merchants'],
  ['Transactions', '/transactions'],
  ['Assets', '/assets'],
  ['Audit logs', '/audit'],
  ['Notifications', '/notifications'],
  ['Settings', '/settings'],
];

describe('NavSidebar', () => {
  it('links every admin section', () => {
    render(<NavSidebar />);

    for (const [label, href] of NAV) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });

  it('describes the build as a testnet demo, never as mainnet-ready', () => {
    render(<NavSidebar />);

    const footer = screen.getByText(/v0\.1\.0/);
    expect(footer).toHaveTextContent(/testnet/i);
    expect(footer).not.toHaveTextContent(/mainnet/i);
  });
});
