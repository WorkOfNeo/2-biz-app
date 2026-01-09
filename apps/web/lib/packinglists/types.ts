export type PackinglistSectionLine = {
  model: string;
  modelType: string | null;
  articleNumber: string | null;
  color: string | null;
  sizes: Record<string, number>; // size -> qty
  totalQty: number; // computed (do not trust PDF total column)
};

export type PackinglistSection = {
  bellRainOrderNo: string | null; // "Our order nr."
  bizPoNo: string | null; // "Your order nr."
  lines: PackinglistSectionLine[];
};

export type PackinglistParseResult = {
  templateId: string;
  templateName: string;
  deliveryDate: string | null; // keep as raw string from PDF for now
  sections: PackinglistSection[];
};

export type PdfTextItem = {
  str: string;
  x: number;
  y: number;
  page: number;
};

export type PdfLine = {
  page: number;
  y: number;
  text: string;
  items: PdfTextItem[];
};

export type PdfExtract = {
  text: string;
  lines: PdfLine[];
};

export type PackinglistTemplate = {
  id: string;
  name: string;
  canParse: (pdf: PdfExtract) => boolean;
  parse: (pdf: PdfExtract) => PackinglistParseResult;
};


