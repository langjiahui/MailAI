// Partition cases, never individual assertions or language/theme combinations.
function partition(items, value=process.env.MAILAI_CI_SHARD) {
  if(!value) return items;
  const match=/^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if(!match) throw new Error('MAILAI_CI_SHARD must be index/count');
  const index=Number(match[1]),count=Number(match[2]);
  if(!Number.isSafeInteger(index)||!Number.isSafeInteger(count)||index>count||count>items.length)
    throw new Error('Invalid or empty CI shard');
  return items.filter((_,position)=>position%count===index-1);
}
module.exports={partition};
