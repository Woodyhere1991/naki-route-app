import {bookingRows,documentRows,rowsFromBackup,buildEntries,summarise,nzDay} from '../../assets/earnings-model.js';
import {readBusinessHistory,historyFinancialRows,businessStatistics} from './business-history.js';

export async function earningsReport(env, backup, currentTime=Date.now()) {
  // Read all records, without the 300-row inbox / 50-document customer limits.
  // Names, addresses, emails, PDFs and credentials never enter this response.
  const [jobs,documents]=await Promise.all([
    env.CUSTOMER_DB.prepare(`SELECT id,status,total_cents,quote_required,quote_cents,quoted_at,updated_at,
      pickup_date,'' AS submission_id,'' AS external_key,'WEBSITE' AS source,
      (SELECT MIN(created_at) FROM booking_events e WHERE e.booking_id=bookings.id
        AND e.event_type='STATUS' AND (e.detail='COMPLETED' OR e.detail LIKE 'COMPLETED %')) AS completed_at
      FROM bookings UNION ALL
      SELECT id,status,total_cents,quote_required,quote_cents,quoted_at,updated_at,pickup_date,
        submission_id,'' AS external_key,'JOTFORM' AS source,completed_at FROM jotform_bookings UNION ALL
      SELECT id,status,total_cents,quote_required,quote_cents,quoted_at,updated_at,pickup_date,
        '' AS submission_id,external_key,'PICKUP_RUN' AS source,completed_at FROM external_bookings`).all(),
    env.CUSTOMER_DB.prepare(`SELECT id,booking_id,kind,amount_cents,created_at FROM booking_documents
      WHERE kind IN ('RECEIPT','INVOICE')`).all()
  ]);
  const history=await readBusinessHistory(env);
  const records=[...bookingRows(jobs.results||[]),...documentRows(documents.results||[]),...rowsFromBackup(backup),...historyFinancialRows(history)];
  const entries=buildEntries(records);
  const stats=env.DOCUMENTS?await businessStatistics(env,history,backup,entries):null;
  return {records,stats,summary:summarise(entries,nzDay(currentTime)),asOf:new Date(currentTime).toISOString(),
    basis:'Completed booking prices, using the latest saved receipt amount when available. Before expenses; Done alone does not confirm payment.',
    timeZone:'Pacific/Auckland'};
}
