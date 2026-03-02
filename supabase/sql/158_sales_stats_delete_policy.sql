-- 158_sales_stats_delete_policy.sql
-- Add delete policy for sales_stats table to allow authenticated users to delete records

drop policy if exists sales_stats_delete_authenticated on public.sales_stats;
create policy sales_stats_delete_authenticated on public.sales_stats 
  for delete 
  to authenticated 
  using (true);
