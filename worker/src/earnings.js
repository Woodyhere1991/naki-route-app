import {bookingRows,documentRows,rowsFromBackup,buildEntries,summarise,nzDay} from '../../assets/earnings-model.js';
import {readBusinessHistory,historyFinancialRows,businessStatistics} from './business-history.js';
import {readInvoiceClearance,clearedDocuments,clearFinancialStops} from './invoice-clearance.js';
import {mergeStatsRows} from '../../assets/business-stats-model.js';
import {readStatisticsExclusions} from './statistics-exclusions.js';

export async function earningsReport(env, backup, currentTime=Date.now()) {
  // Read all records, without the 300-row inbox / 50-document customer limits.
  // Only owner-visible statistics metadata; no emails, full addresses, PDFs or credentials.
  const [jobs,documents]=await Promise.all([
    env.CUSTOMER_DB.prepare(`SELECT id,status,total_cents,quote_required,quote_cents,quoted_at,updated_at,
      pickup_date,'' AS submission_id,'' AS external_key,'WEBSITE' AS source,
      (SELECT MIN(created_at) FROM booking_events e WHERE e.booking_id=bookings.id
        AND e.event_type='STATUS' AND (e.detail='COMPLETED' OR e.detail LIKE 'COMPLETED %')
        AND e.created_at>COALESCE((SELECT MAX(prior.created_at) FROM booking_events prior WHERE prior.booking_id=bookings.id
          AND prior.event_type='STATUS' AND prior.detail!='COMPLETED' AND prior.detail NOT LIKE 'COMPLETED %'),0)) AS completed_at
      FROM bookings UNION ALL
      SELECT id,status,total_cents,quote_required,quote_cents,quoted_at,updated_at,pickup_date,
        submission_id,'' AS external_key,'JOTFORM' AS source,completed_at FROM jotform_bookings UNION ALL
      SELECT id,status,total_cents,quote_required,quote_cents,quoted_at,updated_at,pickup_date,
        '' AS submission_id,external_key,'PICKUP_RUN' AS source,completed_at FROM external_bookings`).all(),
    env.CUSTOMER_DB.prepare(`SELECT id,booking_id,kind,amount_cents,created_at FROM booking_documents
      WHERE kind IN ('RECEIPT','INVOICE')`).all()
  ]);
  const [history,clearance,exclusions]=await Promise.all([readBusinessHistory(env),readInvoiceClearance(env),readStatisticsExclusions(env)]);
  let records=[...bookingRows(jobs.results||[]),...documentRows(clearedDocuments(documents.results||[],clearance)),...clearFinancialStops(rowsFromBackup(backup),clearance),...historyFinancialRows(history,nzDay(currentTime),exclusions)];
  let entries=buildEntries(records);
  const stats=env.DOCUMENTS?await businessStatistics(env,history,backup,entries,exclusions):null;
  if(stats){
    const excluded=new Set(stats.rows.filter(r=>r.test).flatMap(r=>r.aliases));
    records=records.filter(r=>!r.aliases.some(a=>excluded.has(a)));entries=buildEntries(records);stats.rows=mergeStatsRows(stats.rows,entries);
  }
  return {records,stats,invoiceClearance:clearance,summary:summarise(entries,nzDay(currentTime)),asOf:new Date(currentTime).toISOString(),
    basis:'Older bookings counted as collected at the owner’s request, except cancellations, tests and current waiting jobs. Saved booking prices or latest receipts, before expenses.',
    timeZone:'Pacific/Auckland'};
}
