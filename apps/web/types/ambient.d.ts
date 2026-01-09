declare module 'file-saver';
declare module 'jszip';
declare module 'jspdf';
declare module 'jspdf-autotable';

// pdfjs-dist has subpath exports that TypeScript sometimes fails to resolve under Next.js
// even though they exist at runtime.
declare module 'pdfjs-dist/legacy/build/pdf' {
  const pdfjs: any;
  export default pdfjs;
}


