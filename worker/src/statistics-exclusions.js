export const STATISTICS_EXCLUSIONS_KEY='owner-analytics/statistics-exclusions-v1.json';
export async function readStatisticsExclusions(env){
  if(!env.DOCUMENTS)return {customerIds:[],bookingKeys:[]};
  const object=await env.DOCUMENTS.get(STATISTICS_EXCLUSIONS_KEY);
  if(!object)return {customerIds:[],bookingKeys:[]};
  const value=await object.json();
  if(value.version!==1)throw Error('Statistics exclusion policy could not be read');
  return {customerIds:Array.isArray(value.customerIds)?value.customerIds.filter(Boolean):[],bookingKeys:Array.isArray(value.bookingKeys)?value.bookingKeys.filter(Boolean):[]};
}
export function excludedFromStatistics(row,policy={}){
  return Boolean(row.customerId&&(policy.customerIds||[]).includes(row.customerId))||
    [row.key,...(row.aliases||[])].filter(Boolean).some(key=>(policy.bookingKeys||[]).includes(key));
}
