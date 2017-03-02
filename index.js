'use strict';

process.chdir(__dirname);

var fs            = require('fs');
var assert        = require('assert');
var debug         = require('debug')('customizer');
var deepExtend    = require('deep-extend');
var yaml          = require('js-yaml');
var HomeAssistant = require('./lib/home-assistant');
var config        = require('./config.json');

var defaults = {
  debug: false,
  api_url: 'http://localhost:8123/api',
  api_password: null,
  default_hidden: true,
  key_date_added: 'date_added',
  key_date_updated: 'date_updated',
  customize_file: '~/.homeassistant/customize.yaml',
  customize_file_output: null,
  haaska_domains: [
    'automation', 'cover', 'group', 'input_boolean',
    'input_slider', 'light', 'lock', 'media_player',
    'remote', 'scene', 'script', 'switch'
  ],
  homebridge_domains: [
    'binary_sensor', 'cover', 'device_tracker',
    'input_boolean', 'light', 'lock', 'sensor',
    'switch'
  ]
};

var config = deepExtend({}, defaults, config);

if (!config.api_url) {
  throw new Error('Parameter `api_url` is missing in config.json');
}

if (!config.customize_file) {
  throw new Error('Parameter `customize_file` is missing in config.json');
}

if ('undefined' === typeof config.customize_file_backup) {
  config.customize_file_backup = config.customize_file + '.backup';
}

if (!config.customize_file_output) {
  config.customize_file_output = config.customize_file;
}

if (config.customize_file) {
  config.customize_file = config.customize_file.replace(/^~/, process.env['HOME']);
}

if (config.customize_file_output) {
  config.customize_file_output = config.customize_file_output.replace(/^~/, process.env['HOME']);
}

if (config.customize_file_backup) {
  config.customize_file_backup = config.customize_file_backup.replace(/^~/, process.env['HOME']);
}

var hass = new HomeAssistant(config.api_url, config.api_password);

function entityDomain(x) {
  return x.entity_id.split('.', 1)[0];
}

function entityName(x) {
  return x.entity_id.split('.').slice(1).join('.');
}

function supportsHaaska(x) {
  return -1 !== config.haaska_domains.indexOf(entityDomain(x));
}

function supportsHomebridge(x) {
  return -1 !== config.homebridge_domains.indexOf(entityDomain(x));
}

function isHidden(x) {
  var hidden = x.attributes.hidden;

  if ('undefined' === typeof hidden) {
    hidden = config.default_hidden;
  } else if (!hidden || 'no' === hidden || 'false' === hidden || '0' === hidden) {
    hidden = false;
  } else {
    hidden = true;
  }

  return hidden;
}

function isHiddenHaaska(x) {
  var hidden = x.attributes.haaska_hidden;

  if ('undefined' === typeof hidden) {
    hidden = isHidden(x);
  } else if (!hidden || 'no' === hidden || 'false' === hidden || '0' === hidden) {
    hidden = false;
  } else {
    hidden = true;
  }

  return hidden;
}

function isHiddenHomebridge(x) {
  var hidden = x.attributes.homebridge_hidden;

  if ('undefined' === typeof hidden) {
    hidden = isHiddenHaaska(x);
  } else if (!hidden || 'no' === hidden || 'false' === hidden || '0' === hidden) {
    hidden = false;
  } else {
    hidden = true;
  }

  return hidden;
}

function getFriendlyName(x) {
  var friendlyName = x.attributes.friendly_name;

  try {
    if ('undefined' === typeof friendlyName) {
      friendlyName = entityName(x);
    }

    if (friendlyName.match(/[_\.]/) && friendlyName.toLowerCase() === friendlyName) {
      friendlyName = toTitleCase(friendlyName.replace(/[_\.]/g, ' '));
    }
  } catch (ex) {
    friendlyName = null;
  }

  return friendlyName;
}

function toTitleCase(str) {
  return str.replace(/\w\S*/g, function(txt) {
    return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
  });
}

function currentTime() {
  var date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Create a backup file
if (!config.debug && config.customize_file_backup) {
  debug('Writing backup file to %s', config.customize_file_backup);
  fs.writeFileSync(config.customize_file_backup, fs.readFileSync(config.customize_file));
}

var entities  = {};
var customize = yaml.safeLoad(fs.readFileSync(config.customize_file, 'utf8'));

debug('Loaded existing customize data from %s', config.customize_file);

// Convert to an object for easier processing
if (Array.isArray(customize)) {
  debug('Incompatible format detected. Correct format will be used for future output.');

  var customizeTemp = {};

  customize.forEach(function(element) {
    var entity_id = element.entity_id;
    delete element.entity_id;

    customizeTemp[entity_id] = element;
  });

  customize = customizeTemp;
}

hass.get('states', function(err, res, body) {
  if (err) {
    throw err;
  }

  for (var i = 0; i < body.length; i++ ) {
    var x = body[i];

    entities[x.entity_id] = {};

    if (supportsHaaska(x)) {
      entities[x.entity_id]['haaska_hidden'] = isHiddenHaaska(x);
    }

    if (supportsHomebridge(x)) {
      entities[x.entity_id]['homebridge_hidden'] = isHiddenHomebridge(x);
    }

    var friendlyName = getFriendlyName(x);

    if (friendlyName) {
      entities[x.entity_id]['friendly_name'] = friendlyName;
    }
  }

  // Merge the new and existing data
  deepExtend(entities, customize);

  // Add date keys if configured
  if (config.key_date_added || config.key_date_updated) {
    for (var entityId in entities) {
      var entityNew = entities[entityId];
      var entityOld = customize[entityId];

      if (config.key_date_added && 'undefined' === typeof entityOld) {
        entityNew[config.key_date_added] = currentTime();
      }

      if (config.key_date_updated) {
        try {
          assert.deepEqual(entityOld, entityNew);
        } catch (ex) {
          entityNew[config.key_date_updated] = currentTime();
        }
      }
    }
  }

  // Get YAML dump of the object
  var dump = yaml.safeDump(entities, {
    sortKeys: true
  });

  // Unquote mdi: icons
  dump = dump.replace(/icon: 'mdi:[^']+'/g, function(match) {
    return match.replace(/'/g, '');
  });

  var lines = dump.split('\n');

  var output = [];
  var domain = '';

  var entityRegex = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\:$/;

  // Add the file header
  output.push('################################################################');
  output.push('## Customize');
  output.push('################################################################');

  // Loop through and process each line
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Check against the entity_id regex
    var matches = entityRegex.exec(line);

    // Add domain header if it's a new domain
    if (matches) {
      if (matches[1] != domain) {
        domain = matches[1];

        output.push('');
        output.push('################################################');
        output.push('## ' + toTitleCase(domain.replace(/_/g, ' ')));
        output.push('################################################');
      }

      // Add a blank line below the domain header
      output.push('');
    }

    // Add the current line to the output
    output.push(line);
  }

  // Add a footer containing the current timestamp
  output.push('################################################################');
  output.push('# Last Generated: ' + new Date());
  output.push('################################################################');
  output.push('');

  // Convert the array to a string
  output = output.join('\n');

  if (config.debug) {
    debug('%s', output);
  } else {
    fs.writeFileSync(config.customize_file_output, output, 'utf8');
    debug('%s has been updated', config.customize_file_output);
  }
});
