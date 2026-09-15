import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import { Header } from './header';

jest.mock('next/navigation', () => ({ usePathname: jest.fn() }));
// The wallet button pulls in the wallet and auth providers; this suite is about
// the header's own navigation, so it is stubbed out.
jest.mock('./wallet-button', () => ({ WalletButton: () => null }));
jest.mock('next/image', () => ({ __esModule: true, default: () => null }));

const NAV: Array<[label: string, href: string]> = [
  ['Dashboard', '/dashboard'],
  ['Send', '/send'],
  ['Receive', '/receive'],
  ['History', '/history'],
  ['Merchant', '/merchant'],
];

describe('Header', () => {
  it('links every primary destination', () => {
    jest.mocked(usePathname).mockReturnValue('/');
    render(<Header />);

    for (const [label, href] of NAV) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });

  it('highlights the section the user is in', () => {
    jest.mocked(usePathname).mockReturnValue('/send');
    render(<Header />);

    // toHaveClass matches whole tokens, so the inactive links' `hover:bg-accent/60`
    // is not mistaken for the active background.
    expect(screen.getByRole('link', { name: 'Send' })).toHaveClass('bg-accent');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveClass('bg-accent');
  });

  it('keeps a section highlighted on nested routes', () => {
    jest.mocked(usePathname).mockReturnValue('/history/abc123');
    render(<Header />);

    expect(screen.getByRole('link', { name: 'History' })).toHaveClass('bg-accent');
  });
});
