/* jshint node: true,esversion: 9, -W014, -W033 */
/* eslint-disable new-cap */
'use strict'

const { default: PQueue } = require('p-queue')

module.exports = class deviceGarage {
  constructor (platform, accessory) {
    // Set up variables from the platform
    this.funcs = platform.funcs
    this.hapChar = platform.api.hap.Characteristic
    this.hapErr = platform.api.hap.HapStatusError
    this.hapServ = platform.api.hap.Service
    this.lang = platform.lang
    this.log = platform.log
    this.platform = platform

    // Set up variables from the accessory
    this.accessory = accessory
    this.enableLogging = accessory.context.enableLogging
    this.enableDebugLogging = accessory.context.enableDebugLogging
    this.operationTime =
      this.accessory.context.options.operationTime ||
      platform.consts.defaultValues.garageDoorOpeningTime
    this.name = accessory.displayName
    this.pollInterval =
      accessory.context.connection === 'cloud'
        ? this.platform.config.cloudRefreshRate * 1000
        : this.platform.config.refreshRate * 1000
    this.states = {
      0: 'open',
      1: 'closed',
      2: 'opening',
      3: 'closing',
      4: 'stopped'
    }

    // Add the garage door service if it doesn't already exist
    this.service =
      this.accessory.getService(this.hapServ.GarageDoorOpener) ||
      this.accessory.addService(this.hapServ.GarageDoorOpener)

    // Add the set handler to the garage door target state characteristic
    this.service
      .getCharacteristic(this.hapChar.TargetDoorState)
      .onSet(value => this.internalTargetUpdate(value))
    this.cacheTarget = this.service.getCharacteristic(this.hapChar.TargetDoorState).value
    this.cacheCurrent = this.service.getCharacteristic(this.hapChar.CurrentDoorState).value

    // Update the obstruction detected to false on plugin load
    this.service.updateCharacteristic(this.hapChar.ObstructionDetected, false)

    // Create the queue used for sending device requests
    this.updateInProgress = false
    this.queue = new PQueue({
      concurrency: 1,
      interval: 250,
      intervalCap: 1,
      timeout: 10000,
      throwOnTimeout: true
    })
    this.queue.on('idle', () => {
      this.updateInProgress = false
    })

    // Set up the mqtt client for cloud devices to send and receive device updates
    if (accessory.context.connection === 'cloud') {
      this.accessory.mqtt = new (require('./../connection/mqtt'))(platform, this.accessory)
      this.accessory.mqtt.connect()
    }

    // Always request a device update on startup, then enable polling if user enabled
    this.requestUpdate()
    if (this.pollInterval > 0) {
      this.refreshinterval = setInterval(() => this.requestUpdate(), this.pollInterval)
    }

    // Stop the intervals and close mqtt connection on Homebridge shutdown
    platform.api.on('shutdown', () => {
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval)
      }
      if (this.accessory.mqtt) {
        this.accessory.mqtt.disconnect()
      }
    })
  }

  async internalTargetUpdate (value) {
    // Add the request to the queue so updates are send apart
    try {
      return await this.queue.add(async () => {
        let action
        let newTarget = value
        let newCurrent
        if (value === 1) {
          // Request to close the garage door
          if (this.cacheCurrent === 0) {
            // The door is currently open
            // ACTION: close the door
            action = 'close'

            // Mark the current door state as closing
            this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 3)
            newCurrent = 3
          } else if (this.cacheCurrent === 1) {
            // The door is currently closed
            // ACTION: none
            // Mark the current door state as closed
            this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 1)
            newCurrent = 1
          } else if (this.cacheCurrent === 2) {
            // The door is currently opening
            // ACTION: close the door
            action = 'close'

            // Mark the target state as close and current door state as closing
            this.service.updateCharacteristic(this.hapChar.TargetDoorState, 1)
            newTarget = 1
            this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 3)
            newCurrent = 3
          } else if (this.cacheCurrent === 3) {
            // The door is currently closing
            // ACTION: none
            // Mark the current door state as closing
            this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 3)
            newCurrent = 3
          }
        } else if (value === 0) {
          // Request to open the door
          if (this.cacheCurrent === 0) {
            // The door is currently open
            // ACTION: none
            // Mark the current door state as open
            this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 0)
            newCurrent = 0
          } else if (this.cacheCurrent === 1) {
            // The door is currently closed
            // ACTION: open the door
            action = 'open'

            // Mark the current door state as opening
            this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 2)
            newCurrent = 2
          } else if (this.cacheCurrent === 2) {
            // The door is currently opening
            // ACTION: none

            // Mark the current door state as opening
            this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 2)
            newCurrent = 2
          } else if (this.cacheCurrent === 3) {
            // The door is currently closing
            // ACTION: open the door
            action = 'open'

            // Mark the target state as open and current state as opening
            this.service.updateCharacteristic(this.hapChar.TargetDoorState, 0)
            newTarget = 0
            this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 2)
            newCurrent = 2
          }
        }

        // Only send an update if we need to
        if (action) {
          switch (this.accessory.context.connection) {
            case 'cloud': {
              // Setup a three-second timeout to ignore incoming messages
              this.ignoreIncoming = true
              setTimeout(() => {
                this.ignoreIncoming = false
              }, 3000)

              // Send the command
              await this.accessory.mqtt.controlGarageDoor(0, action === 'open')
              break
            }
            case 'local': {
              // Generate the payload and namespace for the correct device model
              const namespace = 'Appliance.GarageDoor.State'
              const payload = {
                state: {
                  channel: 0,
                  open: action === 'open' ? 1 : 0,
                  uuid: this.accessory.context.serialNumber
                }
              }

              // Use the platform function to send the update to the device
              const res = await this.platform.sendLocalDeviceUpdate(
                this.accessory,
                namespace,
                payload
              )

              // Check the response
              if (!res.data || !res.data.header || res.data.header.method === 'ERROR') {
                throw new Error('request failed - ' + JSON.stringify(res.data.payload.error))
              }
              break
            }
          }
        }

        // Update the cache target state if different
        if (this.cacheTarget !== newTarget) {
          this.cacheTarget = newTarget
          if (this.enableLogging) {
            this.log('[%s] current target [%s].', this.states[this.cacheTarget])
          }
        }

        // Update the cache current state if different
        if (this.cacheCurrent !== newCurrent) {
          this.cacheCurrent = newCurrent
          if (this.enableLogging) {
            this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
          }
        }

        /*
          CASE: garage has been opened
          target has been set to [open] and current has been set to [opening]
          wait for the operation time to elapse and set the current to [open]
        */
        if (action === 'open') {
          const updateKey = Math.random()
            .toString(36)
            .substr(2, 8)
          this.updateKey = updateKey
          setTimeout(() => {
            if (updateKey !== this.updateKey) {
              return
            }
            if (this.service.getCharacteristic(this.hapChar.CurrentDoorState).value !== 2) {
              return
            }
            this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 0)
            this.cacheCurrent = 0
            if (this.enableLogging) {
              this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
            }
          }, this.operationTime * 1000)
        }

        /*
          CASE: garage has been closed
          target has been set to [close] and current has been set to [closing]
          wait for the plugin to get a definite closed response from Meross
          For security reasons, I don't want to rely on operation time for the garage to
          definitely show as closed
        */
      })
    } catch (err) {
      // Catch any errors whilst updating the device
      const eText = this.funcs.parseError(err)
      this.log.warn('[%s] sending update failed as %s.', this.name, eText)
      setTimeout(() => {
        this.service.updateCharacteristic(this.hapChar.TargetDoorState, this.cacheTarget)
      }, 2000)
      this.service.updateCharacteristic(this.hapChar.TargetPosition, new this.hapErr(-70402))
    }
  }

  async requestUpdate () {
    try {
      // Don't continue if an update is currently being sent to the device
      if (this.updateInProgress) {
        return
      }

      // Add the request to the queue so updates are send apart
      return await this.queue.add(async () => {
        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true

        // Send the request
        const res =
          this.accessory.context.connection === 'cloud'
            ? await this.accessory.mqtt.getSystemAllData()
            : await this.platform.requestLocalUpdate(this.accessory, 'Appliance.System.All')

        // Log the received data
        if (this.enableDebugLogging) {
          this.log('[%s] incoming poll: %s.', this.name, JSON.stringify(res.data))
        }

        // Validate the response, checking for payload property
        if (!res.data || !res.data.payload) {
          throw new Error('invalid response received')
        }
        const data = res.data.payload

        // Check the response is in a useful format
        if (
          data.all &&
          data.all.digest &&
          data.all.digest.garageDoor &&
          data.all.digest.garageDoor[0]
        ) {
          // Open means magnetic sensor not detected, doesn't really mean the door is open
          const isOpen = data.all.digest.garageDoor[0].open

          switch (this.cacheCurrent) {
            case 0:
            case 2: {
              // Homebridge has garage as open or opening
              if (isOpen) {
                // Meross has reported open
                // Nothing to do
              } else {
                // Meross has reported closed
                this.service.updateCharacteristic(this.hapChar.TargetDoorState, 1)
                this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 1)
                this.cacheCurrent = 1
                this.cacheTarget = 1
                this.log('[%s] target state [%s].', this.name, this.states[this.cacheTarget])
                this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
              }
              break
            }
            case 1: {
              // Homebridge has garage as closed
              if (isOpen) {
                // Meross has reported open
                this.service.updateCharacteristic(this.hapChar.TargetDoorState, 0)
                this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 0)
                this.cacheCurrent = 0
                this.cacheTarget = 0
                this.log('[%s] target state [%s].', this.name, this.states[this.cacheTarget])
                this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
              } else {
                // Meross has reported closed
                // Nothing to do
              }
              break
            }
            case 3: {
              // Homebridge has garage as closing
              if (isOpen) {
                // Meross has reported open
                this.service.updateCharacteristic(this.hapChar.TargetDoorState, 0)
                this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 0)
                this.cacheCurrent = 0
                this.cacheTarget = 0
                this.log('[%s] target state [%s].', this.name, this.states[this.cacheTarget])
                this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
              } else {
                // Meross has reported closed
                this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 0)
                this.cacheCurrent = 0
                this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
              }
            }
          }
        }
      })
    } catch (err) {
      const eText = this.funcs.parseError(err)
      this.log.warn('[%s] failed to refresh status as %s.', this.name, eText)
    }
  }

  externalUpdate (namespace, params) {
    try {
      // Log the received data
      if (this.enableDebugLogging) {
        this.log('[%s] incoming mqtt [%s]: %s.', this.name, namespace, JSON.stringify(params))
      }

      // Validate the response, checking for payload property
      if (!params.payload) {
        throw new Error('invalid response received')
      }
      const data = params.payload

      // Check the response is in a useful format
      if (data.state && data.state[0] && this.funcs.hasProperty(data.state[0], 'open')) {
        // Open means magnetic sensor not detected, doesn't really mean the door is open
        const isOpen = data.all.digest.garageDoor[0].open

        switch (this.cacheCurrent) {
          case 0:
          case 2: {
            // Homebridge has garage as open or opening
            if (isOpen) {
              // Meross has reported open
              // Nothing to do
            } else {
              // Meross has reported closed
              this.service.updateCharacteristic(this.hapChar.TargetDoorState, 1)
              this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 1)
              this.cacheCurrent = 1
              this.cacheTarget = 1
              this.log('[%s] target state [%s].', this.name, this.states[this.cacheTarget])
              this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
            }
            break
          }
          case 1: {
            // Homebridge has garage as closed
            if (isOpen) {
              // Meross has reported open
              this.service.updateCharacteristic(this.hapChar.TargetDoorState, 0)
              this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 0)
              this.cacheCurrent = 0
              this.cacheTarget = 0
              this.log('[%s] target state [%s].', this.name, this.states[this.cacheTarget])
              this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
            } else {
              // Meross has reported closed
              // Nothing to do
            }
            break
          }
          case 3: {
            // Homebridge has garage as closing
            if (isOpen) {
              // Meross has reported open
              this.service.updateCharacteristic(this.hapChar.TargetDoorState, 0)
              this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 0)
              this.cacheCurrent = 0
              this.cacheTarget = 0
              this.log('[%s] target state [%s].', this.name, this.states[this.cacheTarget])
              this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
            } else {
              // Meross has reported closed
              this.service.updateCharacteristic(this.hapChar.CurrentDoorState, 0)
              this.cacheCurrent = 0
              this.log('[%s] current state [%s].', this.name, this.states[this.cacheCurrent])
            }
          }
        }
      }
    } catch (err) {
      const eText = this.funcs.parseError(err)
      this.log.warn('[%s] failed to refresh status as %s.', this.name, eText)
    }
  }
}