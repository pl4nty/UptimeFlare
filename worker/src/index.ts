import { workerConfig } from '../../uptime.config'
import { getWorkerLocation } from './util'
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
    } catch(err) {
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

    // load monitors from Cloudflare proxied DNS records. official API only supports node
    let cfMonitors: MonitorTarget[] = []
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
        method: 'GET'
      }))
    } catch(err) {
      console.log(`Skipping Cloudflare auto-discovery: ${err}`)
    }
    
    // remove duplicates, allowing config to override automatic targets
    let monitors = (workerConfig.monitors as MonitorTarget[]).concat(cfMonitors)
    monitors = monitors.reduce((acc, curr) => {
      if (!acc.find(item => item.id === curr.id)) acc.push(curr)
      return acc
    }, [] as MonitorTarget[])

    // Check each monitor
    // TODO: concurrent status check
    for (const monitor of monitors) {
      console.log(`[${workerLocation}] Checking ${monitor.name}...`)

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
      const lastIncident = state.incident[monitor.id].slice(-1)[0]

      if (status.up) {
        // Current status is up
        // close existing incident if any
        if (lastIncident.end === undefined) {
          lastIncident.end = currentTimeSecond

          try {
            await workerConfig.callbacks.onStatusChange(
              monitor.id,
              monitor.name,
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

          try {
            await workerConfig.callbacks.onStatusChange(
              monitor.id,
              monitor.name,
              false,
              currentTimeSecond,
              currentTimeSecond,
              status.err
            )
          } catch (e) {
            console.log('Error calling callback: ')
            console.log(e)
          }
        } else if (
          lastIncident.end === undefined &&
          lastIncident.error.slice(-1)[0] !== status.err
        ) {
          // append if the error message changes
          lastIncident.start.push(currentTimeSecond)
          lastIncident.error.push(status.err)

          try {
            await workerConfig.callbacks.onStatusChange(
              monitor.id,
              monitor.name,
              false,
              lastIncident.start[0],
              currentTimeSecond,
              status.err
            )
          } catch (e) {
            console.log('Error calling callback: ')
            console.log(e)
          }
        }

        try {
          await workerConfig.callbacks.onIncident(
            monitor.id,
            monitor.name,
            lastIncident.start[0],
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
      if (latencyLists.all.length === 0 || currentTimeSecond - latencyLists.all[0].time > 60 * 60) {
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
    }

    // Update state
    state.lastUpdate = Math.round(Date.now() / 1000)
    await env.UPTIMEFLARE_STATE.put('state', JSON.stringify(state))
  },
}

export default worker
