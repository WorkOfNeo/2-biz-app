import type { MetadataRoute } from 'next';

// Ensure nothing under this app is indexed by search engines.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: '/'
      }
    ],
    // Next expects string|string[]|undefined (not null)
    sitemap: undefined
  };
}


