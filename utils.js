// utils.js

// 1) Distance in miles between two lat/lon
export function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI/180;
  const dLon = (lon2 - lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

// 2) Convert numeric AQI to text category
export function colorCodeAQI(aqi){
  const val = Number(aqi)||0;
  if(val<=50) return 'Good';
  if(val<=100) return 'Moderate';
  if(val<=150) return 'Unhealthy for Sensitive Groups';
  if(val<=200) return 'Unhealthy';
  if(val<=300) return 'Very Unhealthy';
  return 'Hazardous';
}

// 3) Return an inline style that colorizes text based on the numeric AQI
export function getAQIColorStyle(aqi){
  const val = Number(aqi)||0;
  let color='#000'; 
  if(val<=50) color='#009966';       // green
  else if(val<=100) color='#ffde33'; // yellow
  else if(val<=150) color='#ff9933'; // orange
  else if(val<=200) color='#cc0033'; // red
  else if(val<=300) color='#660099'; // purple
  else color='#7e0023';              // maroon
  return `color:${color}; font-weight:bold;`;
}

// 4) Official pm2.5 -> AQI breakpoints (2012 standard)
const PM25_BREAKPOINTS = [
  { pmLow:0.0,    pmHigh:12.0,   aqiLow:0,   aqiHigh:50 },
  { pmLow:12.1,   pmHigh:35.4,   aqiLow:51,  aqiHigh:100 },
  { pmLow:35.5,   pmHigh:55.4,   aqiLow:101, aqiHigh:150 },
  { pmLow:55.5,   pmHigh:150.4,  aqiLow:151, aqiHigh:200 },
  { pmLow:150.5,  pmHigh:250.4,  aqiLow:201, aqiHigh:300 },
  { pmLow:250.5,  pmHigh:500.4,  aqiLow:301, aqiHigh:500 }
];

/**
 * Convert raw pm2.5 (µg/m³) to an approximate AQI using linear interpolation.
 */
export function pm25toAQI(pm){
  let p = pm;
  if(p<0) p=0;
  if(p>500.4) return 500; // clamp
  for(const bp of PM25_BREAKPOINTS){
    if(p>=bp.pmLow && p<=bp.pmHigh){
      const ratio = (p - bp.pmLow)/(bp.pmHigh - bp.pmLow);
      const aqiRange = (bp.aqiHigh - bp.aqiLow);
      return Math.round(bp.aqiLow + ratio*aqiRange);
    }
  }
  return 0;
}

/**
 * Format a future date as "Today at 3:15pm" or "Tomorrow at 1:00am".
 * If it's more than 2 days in the future, we do e.g. "10/04 at 7:00pm".
 */
export function formatDayTimeForUser(d) {
  if(!d) return 'No date';
  const now = new Date();
  // strip times
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = (dateDay - nowDay)/(1000*3600*24);

  let dayStr;
  if(dayDiff<1) {
    dayStr='Today';
  } else if(dayDiff<2) {
    dayStr='Tomorrow';
  } else {
    // fallback => "MM/dd at ..."
    return `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} at ${formatHourMin(d)}`;
  }
  return `${dayStr} at ${formatHourMin(d)}`;
}

// Helper => "12:15pm" format
function formatHourMin(d) {
  let hh = d.getHours();
  const mm = d.getMinutes();
  const ampm = hh>=12 ? 'pm':'am';
  if(hh===0) hh=12;
  else if(hh>12) hh=hh-12;
  const mmStr=mm.toString().padStart(2,'0');
  return `${hh}:${mmStr}${ampm}`;
}
