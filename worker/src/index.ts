import { workerConfig } from '../../uptime.config'
import { formatStatusChangeNotification, getWorkerLocation, notifyWithApprise } from './util'
import { MonitorState, MonitorTarget } from '../../uptime.types'
import { getStatus } from './monitor'

import { dnsRecords } from 'cloudflare-client'

export interface Env {
  UPTIMEFLARE_STATE: KVNamespace,
  CLOUDFLARE_ZONE_ID: string,
  CLOUDFLARE_API_TOKEN: string
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const workerLocation = request.cf?.colo
    console.log(`Handling request event at ${workerLocation}...`)

    if (request.method !== 'POST') {
      return new Response('Remote worker is working...', { status: 405 })
    }

    const targetId = (await request.json<{ target: string }>())['target']

    // check for target in Cloudflare proxied DNS records
    let record
    try {
      const cf = dnsRecords({
        zoneId: env.CLOUDFLARE_ZONE_ID,
        accessToken: env.CLOUDFLARE_API_TOKEN
      })
      record = await cf.find({ proxied: true, name: targetId }).first()
    } catch (err) {
      console.log(`Skipping Cloudflare auto-discovery: ${err}`)
    }

    const target = record ? {
      id: record.name,
      name: record.name,
      target: `https://${record.name}/`,
      tooltip: `https://${record.name}/`,
      method: "GET"
    } : workerConfig.monitors.find((m) => m.id === targetId)

    if (target === undefined) {
      return new Response('Target Not Found', { status: 404 })
    }

    const status = await getStatus(target)

    return new Response(
      JSON.stringify({
        location: workerLocation,
        status: status,
      }),
      {
        headers: {
          'content-type': 'application/json;charset=UTF-8',
        },
      }
    )
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const workerLocation = (await getWorkerLocation()) || 'ERROR'
    console.log(`Running scheduled event on ${workerLocation}...`)

    // Auxiliary function to format notification and send it via apprise
    let formatAndNotify = async (
      monitor: any,
      isUp: boolean,
      timeIncidentStart: number,
      timeNow: number,
      reason: string
    ) => {
      if (workerConfig.notification?.appriseApiServer && workerConfig.notification?.recipientUrl) {
        const notification = formatStatusChangeNotification(
          monitor,
          isUp,
          timeIncidentStart,
          timeNow,
          reason,
          workerConfig.notification?.timeZone ?? 'Etc/GMT'
        )
        await notifyWithApprise(
          workerConfig.notification.appriseApiServer,
          workerConfig.notification.recipientUrl,
          notification.title,
          notification.body
        )
      } else {
        console.log(`Apprise API server or recipient URL not set, skipping apprise notification for ${monitor.name}`)
      }
    }

    // Read state, set init state if it doesn't exist
    let state =
      ((await env.UPTIMEFLARE_STATE.get('state', {
        type: 'json',
      })) as unknown as MonitorState) ||
      ({
        version: 1,
        lastUpdate: 0,
        overallUp: 0,
        overallDown: 0,
        incident: {},
        latency: {},
      } as MonitorState)
    state.overallDown = 0
    state.overallUp = 0

    let statusChanged = false
    const currentTimeSecond = Math.round(Date.now() / 1000)

    // load monitors from Cloudflare proxied DNS records. official API only supports node
    let cfMonitors: MonitorTarget[] = []
    let cfChecked = false;
    try {
      const cf = dnsRecords({
        zoneId: env.CLOUDFLARE_ZONE_ID,
        accessToken: env.CLOUDFLARE_API_TOKEN
      })
      const records = await cf.find({ proxied: true }).all()

      cfMonitors = records.map(monitor => ({
        id: monitor.name,
        name: monitor.name,
        target: `https://${monitor.name}/`,
        method: 'GET',
        // checkLocationWorkerRoute: 'https://status-worker.tplant.com.au/'
      }))
      cfChecked = true;
    } catch (err) {
      console.log(`Skipping Cloudflare auto-discovery: ${err}`)
    }

    // remove duplicates, allowing config to override automatic targets
    let monitors = (workerConfig.monitors as MonitorTarget[]).concat(cfMonitors)
    monitors = monitors.reduce((acc, curr) => {
      if (!acc.find(item => item.id === curr.id)) acc.push(curr)
      return acc
    }, [] as MonitorTarget[])

    // if Cloudflare was checked, remove incidents for monitors that are no longer in the config
    if (cfChecked) {
      for (const id of Object.keys(state.incident)) {
        if (monitors.find(m => m.id === id) === undefined) {
          delete state.incident[id]
        }
      }
    }

    // Check each monitor
    async function processMonitor(monitor: MonitorTarget): Promise<void> {
      console.log(`[${workerLocation}] Checking ${monitor.name}...`)

      let monitorStatusChanged = false
      let checkLocation = workerLocation
      let status

      if (monitor.checkLocationWorkerRoute) {
        // Initiate a check from a different location
        try {
          console.log('Calling worker: ' + monitor.checkLocationWorkerRoute)
          const resp = await (
            await fetch(monitor.checkLocationWorkerRoute, {
              method: 'POST',
              body: JSON.stringify({
                target: monitor.id,
              }),
            })
          ).json<{ location: string; status: { ping: number; up: boolean; err: string } }>()
          checkLocation = resp.location
          status = resp.status
        } catch (err) {
          console.log('Error calling worker: ' + err)
          status = { ping: 0, up: false, err: 'Error initiating check from remote worker' }
        }
      } else {
        // Initiate a check from the current location
        status = await getStatus(monitor)
      }

      // const status = await getStatus(monitor)
      const currentTimeSecond = Math.round(Date.now() / 1000)

      // Update counters
      status.up ? state.overallUp++ : state.overallDown++

      // Update incidents
      // Create a dummy incident to store the start time of the monitoring and simplify logic
      state.incident[monitor.id] = state.incident[monitor.id] || [
        {
          start: [currentTimeSecond],
          end: currentTimeSecond,
          error: ['dummy'],
        },
      ]
      // Then lastIncident here must not be undefined
      let lastIncident = state.incident[monitor.id].slice(-1)[0]

      if (status.up) {
        // Current status is up
        // close existing incident if any
        if (lastIncident.end === undefined) {
          lastIncident.end = currentTimeSecond
          monitorStatusChanged = true
          try {
            if (
              // grace period not set OR ...
              workerConfig.notification?.gracePeriod === undefined ||
              // only when we have sent a notification for DOWN status, we will send a notification for UP status (within 30 seconds of possible drift)
              currentTimeSecond - lastIncident.start[0] >= (workerConfig.notification.gracePeriod + 1) * 60 - 30
            ) {
              await formatAndNotify(
                monitor,
                true,
                lastIncident.start[0],
                currentTimeSecond,
                'OK'
              )
            } else {
              console.log(`grace period (${workerConfig.notification?.gracePeriod}m) not met, skipping apprise UP notification for ${monitor.name}`)
            }

            console.log('Calling config onStatusChange callback...')
            await workerConfig.callbacks.onStatusChange(
              env,
              monitor,
              true,
              lastIncident.start[0],
              currentTimeSecond,
              'OK'
            )
          } catch (e) {
            console.log('Error calling callback: ')
            console.log(e)
          }
        }
      } else {
        // Current status is down
        // open new incident if not already open
        if (lastIncident.end !== undefined) {
          state.incident[monitor.id].push({
            start: [currentTimeSecond],
            end: undefined,
            error: [status.err],
          })
          monitorStatusChanged = true
        } else if (
          lastIncident.end === undefined &&
          lastIncident.error.slice(-1)[0] !== status.err
        ) {
          // append if the error message changes
          lastIncident.start.push(currentTimeSecond)
          lastIncident.error.push(status.err)
          monitorStatusChanged = true
        }

        const currentIncident = state.incident[monitor.id].slice(-1)[0]
        try {
          if (
            // monitor status changed AND...
            (monitorStatusChanged && (
              // grace period not set OR ...
              workerConfig.notification?.gracePeriod === undefined ||
              // have sent a notification for DOWN status
              currentTimeSecond - currentIncident.start[0] >= (workerConfig.notification.gracePeriod + 1) * 60 - 30
            ))
            ||
            (
              // grace period is set AND...
              workerConfig.notification?.gracePeriod !== undefined &&
              (
                // grace period is met
                currentTimeSecond - currentIncident.start[0] >= workerConfig.notification.gracePeriod * 60 - 30 &&
                currentTimeSecond - currentIncident.start[0] < workerConfig.notification.gracePeriod * 60 + 30
              )
            )) {
            await formatAndNotify(
              monitor,
              false,
              currentIncident.start[0],
              currentTimeSecond,
              status.err
            )
          } else {
            console.log(`Grace period (${workerConfig.notification?.gracePeriod}m) not met (currently down for ${currentTimeSecond - currentIncident.start[0]}s, changed ${monitorStatusChanged}), skipping apprise DOWN notification for ${monitor.name}`)
          }

          if (monitorStatusChanged) {
            console.log('Calling config onStatusChange callback...')
            await workerConfig.callbacks.onStatusChange(
              env,
              monitor,
              false,
              currentIncident.start[0],
              currentTimeSecond,
              status.err
            )
          }
        } catch (e) {
          console.log('Error calling callback: ')
          console.log(e)
        }

        try {
          console.log('Calling config onIncident callback...')
          await workerConfig.callbacks.onIncident(
            env,
            monitor,
            currentIncident.start[0],
            currentTimeSecond,
            status.err
          )
        } catch (e) {
          console.log('Error calling callback: ')
          console.log(e)
        }
      }

      // append to latency data
      let latencyLists = state.latency[monitor.id] || {
        recent: [],
        all: [],
      }

      const record = {
        loc: checkLocation,
        ping: status.ping,
        time: currentTimeSecond,
      }
      latencyLists.recent.push(record)
      if (latencyLists.all.length === 0 || currentTimeSecond - latencyLists.all.slice(-1)[0].time > 60 * 60) {
        latencyLists.all.push(record)
      }

      // discard old data
      while (latencyLists.recent[0]?.time < currentTimeSecond - 12 * 60 * 60) {
        latencyLists.recent.shift()
      }
      while (latencyLists.all[0]?.time < currentTimeSecond - 90 * 24 * 60 * 60) {
        latencyLists.all.shift()
      }
      state.latency[monitor.id] = latencyLists

      // discard old incidents
      let incidentList = state.incident[monitor.id]
      while (incidentList.length > 0 && incidentList[0].end && incidentList[0].end < currentTimeSecond - 90 * 24 * 60 * 60) {
        incidentList.shift()
      }

      if (incidentList.length == 0 || (
        incidentList[0].start[0] > currentTimeSecond - 90 * 24 * 60 * 60 &&
        incidentList[0].error[0] != 'dummy'
      )) {
        // put the dummy incident back
        incidentList.unshift(
          {
            start: [currentTimeSecond - 90 * 24 * 60 * 60],
            end: currentTimeSecond - 90 * 24 * 60 * 60,
            error: ['dummy'],
          }
        )
      }
      state.incident[monitor.id] = incidentList

      statusChanged ||= monitorStatusChanged
    }

    async function processMonitorsWithLimit(monitors: MonitorTarget[], limit: number): Promise<void> {
      const pool: Promise<void>[] = [];
      for (const monitor of monitors) {
        const promise = processMonitor(monitor).then(() => {
          // Remove the resolved promise from the pool
          pool.splice(pool.indexOf(promise), 1);
        });
        pool.push(promise);

        // If the pool reaches the limit, wait for one of the promises to resolve
        if (pool.length >= limit) {
          await Promise.race(pool);
        }
      }

      // Wait for all remaining promises to resolve
      await Promise.all(pool);
    }

    // Cloudflare limit to 6 conncurrent fetches, and 50 total on free tier
    // https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
    await processMonitorsWithLimit(monitors, 6)

    console.log(`statusChanged: ${statusChanged}, lastUpdate: ${state.lastUpdate}, currentTime: ${currentTimeSecond}`)
    // Update state
    // Allow for a cooldown period before writing to KV
    if (
      statusChanged ||
      currentTimeSecond - state.lastUpdate >= workerConfig.kvWriteCooldownMinutes * 60 - 10  // Allow for 10 seconds of clock drift
    ) {
      console.log("Updating state...")
      state.lastUpdate = currentTimeSecond
      await env.UPTIMEFLARE_STATE.put('state', JSON.stringify(state))
    } else {
      console.log("Skipping state update due to cooldown period.")
    }
  },
}

export default worker
