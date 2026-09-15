import { render, screen } from '@testing-library/react';
import { notFound } from 'next/navigation';
import { DOC_FILES } from '@/lib/docs';
import DocPage, { generateStaticParams } from './page';

// Next throws from notFound(); the mock reproduces that so the component's
// control flow matches production.
jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

// react-markdown and remark-gfm are ESM-only; stubbing them keeps this suite on
// the route's own behaviour rather than the markdown renderer.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => children,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

function page(slug: string) {
  return DocPage({ params: Promise.resolve({ slug }) });
}

describe('DocPage', () => {
  it('statically generates one route per documented page', () => {
    expect(generateStaticParams()).toEqual(DOC_FILES.map((slug) => ({ slug })));
  });

  it('renders the title of a known slug', async () => {
    render(await page('api'));

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('404s an unknown slug', async () => {
    await expect(page('not-a-real-page')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('404s a path-traversal attempt', async () => {
    await expect(page('../../package')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
