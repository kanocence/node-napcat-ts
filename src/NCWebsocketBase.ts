import { randomUUID } from 'crypto'
import WebSocket, { type RawData } from 'ws'
import type {
  APIRequest,
  AllHandlers,
  EventHandle,
  NCWebsocketOptions,
  ResponseHandler,
  WSErrorRes,
  WSReconnection,
  WSSendParam,
  WSSendReturn
} from './Interfaces.js'
import { NCEventBus } from './NCEventBus.js'
import { convertCQCodeToJSON, CQCodeDecode, logger } from './Utils.js'

export class NCWebsocketBase {
  #debug: boolean

  #baseUrl: string
  #accessToken: string
  #reconnection: WSReconnection
  #socket?: WebSocket

  #eventBus: NCEventBus
  #echoMap: Map<string, ResponseHandler>

  constructor(NCWebsocketOptions: NCWebsocketOptions, debug = false) {
    this.#accessToken = NCWebsocketOptions.accessToken ?? ''

    if ('baseUrl' in NCWebsocketOptions) {
      this.#baseUrl = NCWebsocketOptions.baseUrl
    } else if (
      'protocol' in NCWebsocketOptions &&
      'host' in NCWebsocketOptions &&
      'port' in NCWebsocketOptions
    ) {
      const { protocol, host, port } = NCWebsocketOptions
      this.#baseUrl = protocol + '://' + host + ':' + port
    } else {
      throw new Error(
        'NCWebsocketOptions must contain either "protocol && host && port" or "baseUrl"'
      )
    }

    // 整理重连参数
    const { enable = true, attempts = 10, delay = 5000 } = NCWebsocketOptions.reconnection ?? {}
    this.#reconnection = { enable, attempts, delay, nowAttempts: 1 }

    this.#debug = debug
    this.#eventBus = new NCEventBus(this.#debug)
    this.#echoMap = new Map()
  }

  // ==================WebSocket操作=============================

  connect() {
    this.#eventBus.emit('socket.connecting', { reconnection: this.#reconnection })
    this.#socket = new WebSocket(`${this.#baseUrl}/event?access_token=${this.#accessToken}`)
      .on('open', () => {
        this.#eventBus.emit('socket.open', { reconnection: this.#reconnection })
        this.#reconnection.nowAttempts = 1
      })
      .on('close', (code, reason) => {
        this.#eventBus.emit('socket.close', {
          code,
          reason: reason.toString(),
          reconnection: this.#reconnection
        })
        this.#socket = undefined
        if (
          this.#reconnection.enable &&
          this.#reconnection.nowAttempts < this.#reconnection.attempts
        ) {
          this.#reconnection.nowAttempts++
          setTimeout(this.reconnect.bind(this), this.#reconnection.delay)
        }
      })
      .on('message', (data) => this.#message(data))
      .on('error', (data: WSErrorRes) => {
        data.reconnection = this.#reconnection
        this.#eventBus.emit('socket.error', data)
      })
  }

  disconnect() {
    if (this.#socket !== undefined) {
      this.#socket.close(1000)
      this.#socket = undefined
    }
  }

  reconnect() {
    this.disconnect()
    this.connect()
  }

  #message(data: RawData) {
    let json
    try {
      json = JSON.parse(data.toString())
      if (json.message_format === 'string') {
        json = JSON.parse(CQCodeDecode(json))
        json.message = convertCQCodeToJSON(json.message)
        json.message_format = 'array'
      }
    } catch (error) {
      logger.warn('[node-napcat-ts]', '[socket]', 'failed to parse JSON')
      logger.dir(error)
      return
    }

    if (this.#debug) {
      logger.debug('[node-napcat-ts]', '[socket]', 'receive data')
      logger.dir(json)
    }

    if (json.echo) {
      const handler = this.#echoMap.get(json.echo)

      if (handler) {
        if (json.retcode === 0) {
          this.#eventBus.emit('api.response.success', json)
          handler.onSuccess(json)
        } else {
          this.#eventBus.emit('api.response.failure', json)
          handler.onFailure(json)
        }
      }
    } else {
      this.#eventBus.parseMessage(json)
    }
  }

  // ==================事件绑定=============================

  /**
   * 发送API请求
   * @param method API 端点
   * @param params 请求参数
   */
  send<T extends keyof WSSendParam>(method: T, params: WSSendParam[T]) {
    const echo = randomUUID({ disableEntropyCache: true })

    const message: APIRequest<T> = {
      action: method,
      params: params,
      echo
    }

    if (this.#debug) {
      logger.debug('[node-open-shamrock] send request')
      logger.dir(message)
    }

    return new Promise<WSSendReturn[T]>((resolve, reject) => {
      const onSuccess = (response: any) => {
        this.#echoMap.delete(echo)
        return resolve(response.data)
      }

      const onFailure = (reason: any) => {
        this.#echoMap.delete(echo)
        return reject(reason)
      }

      this.#echoMap.set(echo, {
        message,
        onSuccess,
        onFailure
      })

      this.#eventBus.emit('api.preSend', message)

      if (this.#socket === undefined) {
        reject({
          status: 'failed',
          retcode: -1,
          data: null,
          message: 'api socket is not connected',
          echo: ''
        })
      } else if (this.#socket.readyState === WebSocket.CLOSING) {
        reject({
          status: 'failed',
          retcode: -1,
          data: null,
          message: 'api socket is closed',
          echo: ''
        })
      } else {
        this.#socket.send(JSON.stringify(message))
      }
    })
  }

  /**
   * 注册监听方法
   * @param event
   * @param handle
   */
  on<T extends keyof AllHandlers>(event: T, handle: EventHandle<T>) {
    this.#eventBus.on(event, handle)
    return this
  }

  /**
   * 只执行一次
   * @param event
   * @param handle
   */
  once<T extends keyof AllHandlers>(event: T, handle: EventHandle<T>) {
    this.#eventBus.once(event, handle)
    return this
  }

  /**
   * 解除监听方法
   * @param event
   * @param handle
   */
  off<T extends keyof AllHandlers>(event: T, handle: EventHandle<T>) {
    this.#eventBus.off(event, handle)
    return this
  }

  /**
   * 手动模拟触发某个事件
   * @param type
   * @param context
   */
  emit<T extends keyof AllHandlers>(type: T, context: AllHandlers[T]) {
    this.#eventBus.emit(type, context)
    return this
  }
}
