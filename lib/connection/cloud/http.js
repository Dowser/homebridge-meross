/* jshint node: true,esversion: 9, -W014, -W033 */
/* eslint-disable new-cap */
'use strict'

const axios = require('axios')
const crypto = require('crypto')

module.exports = class connectionHTTP {
  constructor (platform) {
    this.consts = platform.consts
    this.debug = platform.config.debug
    this.funcs = platform.funcs
    this.log = platform.log
    this.password = platform.config.password
    this.username = platform.config.username
    this.userkey = platform.config.userkey
  }

  async login () {
    try {
      const nonce = this.funcs.generateRandomString(16)
      const timestampMillis = Date.now()
      const loginParams = this.funcs.encodeParams({
        email: this.username,
        password: this.password
      })

      // Generate the md5-hash (called signature)
      const datatosign = '23x17ahWarFH6w29' + timestampMillis + nonce + loginParams
      const md5hash = crypto
        .createHash('md5')
        .update(datatosign)
        .digest('hex')

      const res = await axios({
        url: 'https://iot.meross.com/v1/Auth/Login',
        method: 'post',
        headers: {
          Authorization: 'Basic ',
          vender: 'Meross',
          AppVersion: '1.3.0',
          AppLanguage: 'EN',
          'User-Agent': 'okhttp/3.6.0'
        },
        data: {
          params: loginParams,
          sign: md5hash,
          timestamp: timestampMillis,
          nonce: nonce
        }
      })

      // Check to see we got a response
      if (!res.data) {
        throw new Error('no response received from Meross server')
      }

      if (!res.data.info || res.data.info !== 'Success' || !res.data.data) {
        if (res.data.info === 'Username is not exist or password is wrong') {
          if (this.base64Tried) {
            throw new Error(res.data.info || 'login failed - ' + JSON.stringify(res.data))
          } else {
            this.base64Tried = true
            this.password = Buffer.from(this.password, 'base64')
              .toString('utf8')
              .replace(/(\r\n|\n|\r)/gm, '')
              .trim()
            return await this.login()
          }
        }
        throw new Error(res.data.info || 'login failed - ' + JSON.stringify(res.data))
      }
      this.key = res.data.data.key
      this.token = res.data.data.token
      this.userid = res.data.data.userid
      if (this.debug && !this.userkey) {
        this.log.warn('Meross Key: %s', this.key)
      }
      return {
        key: this.key,
        token: this.token,
        userid: this.userid
      }
    } catch (err) {
      if (err.code && this.consts.httpRetryCodes.includes(err.code)) {
        // Retry if another attempt could be successful
        this.log.warn('%s [login() - %s].', this.lang.httpRetry, err.code)
        await this.funcs.sleep(30000)
        return await this.login()
      } else {
        throw err
      }
    }
  }

  async getDevices () {
    try {
      if (!this.key || !this.token || !this.userid) {
        throw new Error('not authenticated')
      }

      const nonce = this.funcs.generateRandomString(16)
      const timestampMillis = Date.now()
      const loginParams = this.funcs.encodeParams({})

      // Generate the md5-hash (called signature)
      const datatosign = '23x17ahWarFH6w29' + timestampMillis + nonce + loginParams
      const md5hash = crypto
        .createHash('md5')
        .update(datatosign)
        .digest('hex')

      const res = await axios({
        url: 'https://iot.meross.com/v1/Device/devList',
        method: 'post',
        headers: {
          Authorization: 'Basic ' + this.token,
          vender: 'Meross',
          AppVersion: '1.3.0',
          AppLanguage: 'EN',
          'User-Agent': 'okhttp/3.6.0'
        },
        data: {
          params: loginParams,
          sign: md5hash,
          timestamp: timestampMillis,
          nonce: nonce
        }
      })

      // Check to see we got a response
      if (!res.data) {
        throw new Error('no response received from Meross server')
      }

      if (
        res.data.info !== 'Success' ||
        !this.funcs.hasProperty(res.data, 'data') ||
        !Array.isArray(res.data.data)
      ) {
        throw new Error('invalid device list received - ' + JSON.stringify(res.data))
      }

      // Return the device list to the platform
      return res.data.data
    } catch (err) {
      if (err.code && this.consts.httpRetryCodes.includes(err.code)) {
        // Retry if another attempt could be successful
        this.log.warn('%s [getDevices() - %s].', this.lang.httpRetry, err.code)
        await this.funcs.sleep(30000)
        return await this.login()
      } else {
        throw err
      }
    }
  }

  async getSubDevices (device) {
    try {
      if (!this.key || !this.token || !this.userid) {
        throw new Error('not authenticated')
      }

      const nonce = this.funcs.generateRandomString(16)
      const timestampMillis = Date.now()
      const loginParams = this.funcs.encodeParams({
        uuid: device.uuid
      })

      // Generate the md5-hash (called signature)
      const datatosign = '23x17ahWarFH6w29' + timestampMillis + nonce + loginParams
      const md5hash = crypto
        .createHash('md5')
        .update(datatosign)
        .digest('hex')

      const res = await axios({
        url: 'https://iot.meross.com/v1/Hub/getSubDevices',
        method: 'post',
        headers: {
          Authorization: 'Basic ' + this.token,
          vender: 'Meross',
          AppVersion: '1.3.0',
          AppLanguage: 'EN',
          'User-Agent': 'okhttp/3.6.0'
        },
        data: {
          params: loginParams,
          sign: md5hash,
          timestamp: timestampMillis,
          nonce: nonce
        }
      })

      // Check to see we got a response
      if (!res.data) {
        throw new Error('no response received from Meross server')
      }

      if (
        res.data.info !== 'Success' ||
        !this.funcs.hasProperty(res.data, 'data') ||
        !Array.isArray(res.data.data)
      ) {
        throw new Error('invalid subdevice list received - ' + JSON.stringify(res.data))
      }

      // Return the subdevice list to the platform
      return res.data.data
    } catch (err) {
      if (err.code && this.consts.httpRetryCodes.includes(err.code)) {
        // Retry if another attempt could be successful
        this.log.warn('%s [getDevices() - %s].', this.lang.httpRetry, err.code)
        await this.funcs.sleep(30000)
        return await this.login()
      } else {
        throw err
      }
    }
  }
}