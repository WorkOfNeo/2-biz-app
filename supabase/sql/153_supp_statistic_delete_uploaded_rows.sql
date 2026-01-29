-- 153_supp_statistic_delete_uploaded_rows.sql
-- Deletes all rows that are NOT made manually.
--
-- Manual data = entered via "Historisk Data" (supp_statistic only; no rows in supp_statistic_rows).
-- Upload data = from Excel/CSV on Suppleringer: supp_statistic_rows + supp_statistic aggregates for those months.
--
-- This script:
-- 1. Deletes supp_statistic aggregates for months that have upload-derived rows (so only manual-only months remain).
-- 2. Deletes all supp_statistic_rows (every row there is from file upload).
--
-- Run manually when you want to clear all upload-derived data and keep only manually entered statistics.

-- 1. Remove aggregate stats for months that have (or had) uploaded row data
delete from public.supp_statistic
where year_month in (select distinct year_month from public.supp_statistic_rows);

-- 2. Remove all uploaded detail rows
delete from public.supp_statistic_rows;
