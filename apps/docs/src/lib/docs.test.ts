import { DOC_FILES, listDocs, readDoc } from './docs';

describe('listDocs', () => {
  it('resolves every slug in the navigation to a real docs/*.md file', () => {
    const listed = listDocs();

    expect(listed.map((doc) => doc.slug)).toEqual([...DOC_FILES]);
    for (const doc of listed) {
      expect(doc.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate slugs', () => {
    expect(new Set(DOC_FILES).size).toBe(DOC_FILES.length);
  });
});

describe('readDoc', () => {
  it('reads a documented page with its body', () => {
    const doc = readDoc('api');

    expect(doc?.slug).toBe('api');
    expect(doc?.content).toContain('#');
  });

  it('returns null for a slug that is not in the navigation', () => {
    expect(readDoc('not-a-real-page')).toBeNull();
  });

  it('refuses to escape the docs directory', () => {
    // `readDoc` resolves the slug against docs/ and validates it against
    // DOC_FILES, so traversal never reaches the filesystem.
    expect(readDoc('../package')).toBeNull();
    expect(readDoc('../../etc/passwd')).toBeNull();
    expect(readDoc('../docs/api')).toBeNull();
  });
});
