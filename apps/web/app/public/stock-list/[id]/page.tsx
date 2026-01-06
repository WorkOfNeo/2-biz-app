import StockListPage from '../../../styles/stock-list/page';

export default function PublicStockListPage({ params }: { params: { id: string } }) {
  return <StockListPage publicMode sharedListId={params.id} />;
}


