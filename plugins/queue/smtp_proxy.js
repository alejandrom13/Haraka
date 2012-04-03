// Forward to an SMTP server as a proxy.
// Opens the connection to the ongoing SMTP server at MAIL FROM time
// and passes back any errors seen on the ongoing server to the originating server.

var sock = require('./line_socket');
var smtp_regexp = /^([0-9]{3})([ -])(.*)/;

exports.register = function () {
    this.inherits('queue/conn_pool_base');
}

exports.hook_mail = function (next, connection, params) {
    connection.loginfo(this, "proxying");
    var self = this;
    var mail_from = params[0];
    var data_marker = 0;
    var config = self.config.get('smtp_proxy.ini');
    var host = (config.main.host) ? config.main.host : 'localhost';
    var port = (config.main.port) ? config.main.port : 25;
    var timeout = (config.main.timeout || config.main.timeout == 0) ?
        config.main.timeout : 300;
    var smtp_proxy = self.conn_get(self, next, connection, host, port, timeout);
    var in_write = false;
    var dot_pending = true;

    if (!smtp_proxy.pool_connection) {
        smtp_proxy.command = 'connect';
    }

    smtp_proxy.set_next = function (cb) {
        this.next_called = false;

        this.next = function (retval, msg) {
            this.next_called = true;

            if (retval && msg) {
                return cb(retval, msg);
            }
            else if(retval) {
                return cb(retval);
            }
            else {
                return cb();
            }
        };
    };
    smtp_proxy.set_next(next);

    // Call this in the case of socket error, or the socket throws an error.
    var socket_error = function (err) {
        connection.logdebug(self, "Ongoing connection failed: " + err);

        if (smtp_proxy) {
            smtp_proxy.next(DENYSOFT,'Proxy connection failed');
        }

        self.conn_destroy(self, connection, smtp_proxy);
    };

    smtp_proxy.send_data = function () {
        var wrote_all = true;

        try {
            while (wrote_all &&
                  (data_marker < connection.transaction.data_lines.length)) {
                var line = connection.transaction.data_lines[data_marker];
                data_marker++;
                connection.logdata(self, "C: " + line);
                // this protection is due to bug #
                in_write = true;
                wrote_all = smtp_proxy.socket.write(
                    line.replace(/^\./, '..').replace(/\r?\n/g, '\r\n'));
                in_write = false;
                if (!wrote_all) {
                    return;
                }
            }
            // we get here if wrote_all still true,
            // and we got to end of data_lines
            if (dot_pending) {
                dot_pending = false;
                smtp_proxy.socket.send_command('dot');
            }
        }
        catch (err) {
            socket_error(err);
            return;
        }
    }

    // Add socket event listeners.
    smtp_proxy.socket.on('drain', function() {
        if (dot_pending && smtp_proxy.command === 'mailbody') {
            process.nextTick(function () { smtp_proxy.send_data() });
        }
    });

    smtp_proxy.socket.on('error', socket_error);

    smtp_proxy.socket.on('timeout', function () {
        connection.logdebug(self, "Ongoing connection timed out");
    });
    
    smtp_proxy.socket.on('close', function (had_error) {
        connection.logdebug(self, "Ongoing connection closed");
    });

    smtp_proxy.socket.on('connect', function () {
        connection.logdebug(self, "Ongoing connection established");
    });
    
    smtp_proxy.socket.send_command = function (cmd, data) {
        var line = cmd + (data ? (' ' + data) : '');

        if (cmd === 'dot') {
            line = '.';
        }

        connection.logprotocol(self, "C: " + line);

        try {
            this.write(line + "\r\n");
        }
        catch (err) {
            socket_error(err);
            return;
        }

        smtp_proxy.command = cmd.toLowerCase();
        smtp_proxy.response = [];
    };
    
    smtp_proxy.socket.on('line', function (line) {
        var matches;
        connection.logprotocol(self, "S: " + line);
        if (matches = smtp_regexp.exec(line)) {
            var code = matches[1],
                cont = matches[2],
                rest = matches[3];
            smtp_proxy.response.push(rest);
            if (cont === ' ') {
                if (smtp_proxy.command === 'ehlo') {
                    // Handle fallback to HELO if EHLO is rejected
                    if (code.match(/^5/)) {
                        if (smtp_proxy.xclient) {
                            smtp_proxy.socket.send_command('HELO',
                                connection.hello_host);
                        } 
                        else {
                            smtp_proxy.socket.send_command('HELO',
                                self.config.get('me'));
                        }
                        return;
                    }
                    // Parse CAPABILITIES
                    for (var i in smtp_proxy.response) {
                        if (smtp_proxy.response[i].match(/^XCLIENT/)) {
                            if (!smtp_proxy.xclient) {
                                smtp_proxy.socket.send_command('XCLIENT',
                                    'ADDR=' + connection.remote_ip);
                                return;
                            }
                        }
                        if (smtp_proxy.response[i].match(/^STARTTLS/)) {
                            var key = self.config.get(
                                'tls_key.pem', 'data').join("\n");
                            var cert = self.config.get(
                                'tls_cert.pem', 'data').join("\n");
                            if (key && cert && (/(true|yes|1)/i.exec(
                                smtp_proxy.config.main.enable_tls))) {
                                this.on('secure', function () {
                                    smtp_proxy.socket.send_command('EHLO',
                                        self.config.get('me'));
                                });
                                smtp_proxy.socket.send_command('STARTTLS');
                                return;
                            }
                        }
                    }
                }
                if (smtp_proxy.command === 'xclient' && code.match(/^5/)) {
                    // XCLIENT rejected; continue without it
                    smtp_proxy.command = 'helo';
                }
                else if (code.match(/^[45]/)) {
                    var response_array = smtp_proxy.response.slice();
                    if (smtp_proxy.command !== 'rcpt') {
                        // errors are OK for rcpt, but nothing else
                        // this can also happen if the destination server
                        // times out, but that is okay.
                        connection.loginfo(self,
                           "message denied, proxying failed");
                        smtp_proxy.socket.send_command('RSET');
                    }

                    if (smtp_proxy) {
                        return smtp_proxy.next(code.match(/^4/) ?
                            DENYSOFT : DENY, response_array);
                    }
                    else {
                        return;
                    }
                }
                switch (smtp_proxy.command) {
                    case 'xclient':
                        smtp_proxy.xclient = true;
                        smtp_proxy.socket.send_command('EHLO',
                            connection.hello_host);
                        break;
                    case 'starttls':
                        var tls_options = { key: key, cert: cert };
                        smtp_proxy.socket.upgrade(tls_options);
                        break;
                    case 'connect':
                        smtp_proxy.socket.send_command('EHLO',
                            self.config.get('me'));
                        break;
                    case 'ehlo':
                    case 'helo':
                        smtp_proxy.socket.send_command('MAIL',
                            'FROM:' + mail_from);
                        break;
                    case 'mail':
                        if (smtp_proxy) smtp_proxy.next();
                        break;
                    case 'rcpt':
                        if (smtp_proxy) smtp_proxy.next();
                        break;
                    case 'data':
                        if (smtp_proxy) smtp_proxy.next();
                        break;
                    case 'dot':
                        connection.loginfo(self,
                            "message delivered, proxying complete");
                        if (smtp_proxy) {
                            smtp_proxy.next(OK, smtp_proxy.response + ' (' +
                                connection.transaction.uuid + ')');
                            smtp_proxy.socket.send_command('RSET');
                        }
                        break;
                    case 'rset':
                        if (smtp_proxy && !smtp_proxy.next_called) {
                            smtp_proxy.next();
                        }
                        self.conn_idle(self, connection);
                        break;
                    default:
                        throw "Unknown command: " + smtp_proxy.command;
                }
            }
        }
        else {
            // Unrecognised response.
            connection.logerror(self,
                "Unrecognised response from upstream server: " + line);
            connection.loginfo(self, "message denied, proxying failed");
            smtp_proxy.socket.send_command('RSET');
            if (smtp_proxy) return smtp_proxy.next(DENYSOFT);
        }
    });

    if (smtp_proxy.pool_connection) {
        // If we used XCLIENT earlier; we *must* re-send it again
        // To update the proxy with the new client details.
        if (smtp_proxy.xclient) {
            smtp_proxy.socket.send_command('XCLIENT',
                'ADDR=' + connection.remote_ip);
        }
        else {
            smtp_proxy.socket.send_command('MAIL', 'FROM:' + mail_from);
        }
    }
};

exports.hook_rcpt_ok = function (next, connection, recipient) {
    var smtp_proxy = connection.notes.conn;
    if (!smtp_proxy) return next();
    smtp_proxy.set_next(next);
    smtp_proxy.socket.send_command('RCPT', 'TO:' + recipient);
};

exports.hook_data = function (next, connection) {
    var smtp_proxy = connection.notes.conn;
    if (!smtp_proxy) return next();
    smtp_proxy.set_next(next);
    smtp_proxy.socket.send_command("DATA");
};

exports.hook_queue = function (next, connection) {
    var smtp_proxy = connection.notes.conn;
    if (!smtp_proxy) return next();
    smtp_proxy.command = 'mailbody';
    smtp_proxy.set_next(next);
    smtp_proxy.send_data();
};

exports.hook_rset = function (next, connection) {
    this.rset_proxy(next, connection);
}

exports.hook_quit = function (next, connection) {
    this.rset_proxy(next, connection);
}

exports.hook_disconnect = function (next, connection) {
    // XXX: what if this happens durring data or queue?
    this.rset_proxy(next, connection);
};

exports.rset_proxy = function (next, connection) {
    var smtp_proxy = connection.notes.conn;
    if (!smtp_proxy) return next();
    smtp_proxy.set_next(next);
    smtp_proxy.socket.send_command("RSET");
};
