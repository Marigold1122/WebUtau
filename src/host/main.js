import { createHostApp } from './app/createHostApp.js'

const hostApp = createHostApp()
hostApp.init()

window.hostApp = hostApp
