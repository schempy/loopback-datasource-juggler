/*!
 * Dependencies
 */
var assert = require('assert');
var util = require('util');
var i8n = require('inflection');
var defineScope = require('./scope.js').defineScope;
var mergeQuery = require('./scope.js').mergeQuery;
var ModelBaseClass = require('./model.js');
var applyFilter = require('./connectors/memory').applyFilter;
var ValidationError = require('./validations.js').ValidationError;

exports.Relation = Relation;
exports.RelationDefinition = RelationDefinition;

var RelationTypes = {
  belongsTo: 'belongsTo',
  hasMany: 'hasMany',
  hasOne: 'hasOne',
  hasAndBelongsToMany: 'hasAndBelongsToMany',
  referencesMany: 'referencesMany',
  embedsMany: 'embedsMany'
};

exports.RelationTypes = RelationTypes;
exports.HasMany = HasMany;
exports.HasManyThrough = HasManyThrough;
exports.HasOne = HasOne;
exports.HasAndBelongsToMany = HasAndBelongsToMany;
exports.BelongsTo = BelongsTo;
exports.ReferencesMany = ReferencesMany;
exports.EmbedsMany = EmbedsMany;

var RelationClasses = {
  belongsTo: BelongsTo,
  hasMany: HasMany,
  hasManyThrough: HasManyThrough,
  hasOne: HasOne,
  hasAndBelongsToMany: HasAndBelongsToMany,
  referencesMany: ReferencesMany,
  embedsMany: EmbedsMany
};

function normalizeType(type) {
  if (!type) {
    return type;
  }
  var t1 = type.toLowerCase();
  for (var t2 in RelationTypes) {
    if (t2.toLowerCase() === t1) {
      return t2;
    }
  }
  return null;
};

function extendScopeMethods(definition, scopeMethods, ext) {
  var customMethods = [];
  var relationClass = RelationClasses[definition.type];
  if (definition.type === RelationTypes.hasMany && definition.modelThrough) {
    relationClass = RelationClasses.hasManyThrough;
  }
  if (typeof ext === 'function') {
    customMethods = ext.call(definition, scopeMethods, relationClass);
  } else if (typeof ext === 'object') {
    for (var key in ext) {
      var relationMethod = ext[key];
      var method = scopeMethods[key] = function () {
        var relation = new relationClass(definition, this);
        return relationMethod.apply(relation, arguments);
      };
      if (relationMethod.shared) {
        sharedMethod(definition, key, method, relationMethod);
      }
      customMethods.push(key);
    }
  }
  return [].concat(customMethods || []);
};

/**
 * Relation definition class.  Use to define relationships between models.
 * @param {Object} definition
 * @class RelationDefinition
 */
function RelationDefinition(definition) {
  if (!(this instanceof RelationDefinition)) {
    return new RelationDefinition(definition);
  }
  definition = definition || {};
  this.name = definition.name;
  this.accessor = definition.accessor || this.name;
  assert(this.name, 'Relation name is missing');
  this.type = normalizeType(definition.type);
  assert(this.type, 'Invalid relation type: ' + definition.type);
  this.modelFrom = definition.modelFrom;
  assert(this.modelFrom, 'Source model is required');
  this.keyFrom = definition.keyFrom;
  this.modelTo = definition.modelTo;
  this.keyTo = definition.keyTo;
  this.discriminator = definition.discriminator;
  if (!this.discriminator) {
    assert(this.modelTo, 'Target model is required');
  }
  this.modelThrough = definition.modelThrough;
  this.keyThrough = definition.keyThrough;
  this.multiple = (this.type !== 'belongsTo' && this.type !== 'hasOne');
  this.properties = definition.properties || {};
  this.options = definition.options || {};
  this.scope = definition.scope;
  this.embed = definition.embed === true;
}

RelationDefinition.prototype.toJSON = function () {
  var json = {
    name: this.name,
    type: this.type,
    modelFrom: this.modelFrom.modelName,
    keyFrom: this.keyFrom,
    modelTo: this.modelTo.modelName,
    keyTo: this.keyTo,
    multiple: this.multiple
  };
  if (this.modelThrough) {
    json.modelThrough = this.modelThrough.modelName;
    json.keyThrough = this.keyThrough;
  }
  return json;
};

/**
 * Apply the configured scope to the filter/query object.
 * @param {Object} modelInstance
 * @param {Object} filter (where, order, limit, fields, ...)
 */
RelationDefinition.prototype.applyScope = function(modelInstance, filter) {
  filter = filter || {};
  filter.where = filter.where || {};
  if ((this.type !== 'belongsTo' || this.type === 'hasOne')
    && typeof this.discriminator === 'string') { // polymorphic
    filter.where[this.discriminator] = this.modelFrom.modelName;
  }
  if (typeof this.scope === 'function') {
    var scope = this.scope.call(this, modelInstance, filter);
  } else {
    var scope = this.scope;
  }
  if (typeof scope === 'object') {
    mergeQuery(filter, scope);
  }
};

/**
 * Apply the configured properties to the target object.
 * @param {Object} modelInstance
 * @param {Object} target
 */
RelationDefinition.prototype.applyProperties = function(modelInstance, target) {
  if (typeof this.properties === 'function') {
    var data = this.properties.call(this, modelInstance);
    for(var k in data) {
      target[k] = data[k];
    }
  } else if (typeof this.properties === 'object') {
    for(var k in this.properties) {
      var key = this.properties[k];
      target[key] = modelInstance[k];
    }
  }
  if ((this.type !== 'belongsTo' || this.type === 'hasOne')
    && typeof this.discriminator === 'string') { // polymorphic
    target[this.discriminator] = this.modelFrom.modelName;
  }
};

/**
 * A relation attaching to a given model instance
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {Relation}
 * @constructor
 * @class Relation
 */
function Relation(definition, modelInstance) {
  if (!(this instanceof Relation)) {
    return new Relation(definition, modelInstance);
  }
  if (!(definition instanceof RelationDefinition)) {
    definition = new RelationDefinition(definition);
  }
  this.definition = definition;
  this.modelInstance = modelInstance;
}

Relation.prototype.resetCache = function (cache) {
  cache = cache || undefined;
  this.modelInstance.__cachedRelations[this.definition.name] = cache;
};

Relation.prototype.getCache = function () {
  return this.modelInstance.__cachedRelations[this.definition.name];
};

/**
 * HasMany subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {HasMany}
 * @constructor
 * @class HasMany
 */
function HasMany(definition, modelInstance) {
  if (!(this instanceof HasMany)) {
    return new HasMany(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.hasMany);
  Relation.apply(this, arguments);
}

util.inherits(HasMany, Relation);

HasMany.prototype.removeFromCache = function (id) {
  var cache = this.modelInstance.__cachedRelations[this.definition.name];
  var idName = this.definition.modelTo.definition.idName();
  if (Array.isArray(cache)) {
    for (var i = 0, n = cache.length; i < n; i++) {
      if (cache[i][idName] === id) {
        return cache.splice(i, 1);
      }
    }
  }
  return null;
};

HasMany.prototype.addToCache = function (inst) {
  if (!inst) {
    return;
  }
  var cache = this.modelInstance.__cachedRelations[this.definition.name];
  if (cache === undefined) {
    cache = this.modelInstance.__cachedRelations[this.definition.name] = [];
  }
  var idName = this.definition.modelTo.definition.idName();
  if (Array.isArray(cache)) {
    for (var i = 0, n = cache.length; i < n; i++) {
      if (cache[i][idName] === inst[idName]) {
        cache[i] = inst;
        return;
      }
    }
    cache.push(inst);
  }
};

/**
 * HasManyThrough subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {HasManyThrough}
 * @constructor
 * @class HasManyThrough
 */
function HasManyThrough(definition, modelInstance) {
  if (!(this instanceof HasManyThrough)) {
    return new HasManyThrough(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.hasMany);
  assert(definition.modelThrough);
  HasMany.apply(this, arguments);
}

util.inherits(HasManyThrough, HasMany);

/**
 * BelongsTo subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {BelongsTo}
 * @constructor
 * @class BelongsTo
 */
function BelongsTo(definition, modelInstance) {
  if (!(this instanceof BelongsTo)) {
    return new BelongsTo(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.belongsTo);
  Relation.apply(this, arguments);
}

util.inherits(BelongsTo, Relation);

/**
 * HasAndBelongsToMany subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {HasAndBelongsToMany}
 * @constructor
 * @class HasAndBelongsToMany
 */
function HasAndBelongsToMany(definition, modelInstance) {
  if (!(this instanceof HasAndBelongsToMany)) {
    return new HasAndBelongsToMany(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.hasAndBelongsToMany);
  Relation.apply(this, arguments);
}

util.inherits(HasAndBelongsToMany, Relation);

/**
 * HasOne subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {HasOne}
 * @constructor
 * @class HasOne
 */
function HasOne(definition, modelInstance) {
  if (!(this instanceof HasOne)) {
    return new HasOne(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.hasOne);
  Relation.apply(this, arguments);
}

util.inherits(HasOne, Relation);

/**
 * EmbedsMany subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {EmbedsMany}
 * @constructor
 * @class EmbedsMany
 */
function EmbedsMany(definition, modelInstance) {
  if (!(this instanceof EmbedsMany)) {
    return new EmbedsMany(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.embedsMany);
  Relation.apply(this, arguments);
}

util.inherits(EmbedsMany, Relation);

/**
 * ReferencesMany subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {ReferencesMany}
 * @constructor
 * @class ReferencesMany
 */
function ReferencesMany(definition, modelInstance) {
  if (!(this instanceof ReferencesMany)) {
    return new ReferencesMany(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.referencesMany);
  Relation.apply(this, arguments);
}

util.inherits(ReferencesMany, Relation);

/*!
 * Find the relation by foreign key
 * @param {*} foreignKey The foreign key
 * @returns {Object} The relation object
 */
function findBelongsTo(modelFrom, modelTo, keyTo) {
  var relations = modelFrom.relations;
  var keys = Object.keys(relations);
  for (var k = 0; k < keys.length; k++) {
    var rel = relations[keys[k]];
    if (rel.type === RelationTypes.belongsTo &&
      rel.modelTo === modelTo &&
      (keyTo === undefined || rel.keyTo === keyTo)) {
      return rel.keyFrom;
    }
  }
  return null;
}

/*!
 * Look up a model by name from the list of given models
 * @param {Object} models Models keyed by name
 * @param {String} modelName The model name
 * @returns {*} The matching model class
 */
function lookupModel(models, modelName) {
  if(models[modelName]) {
    return models[modelName];
  }
  var lookupClassName = modelName.toLowerCase();
  for (var name in models) {
    if (name.toLowerCase() === lookupClassName) {
      return models[name];
    }
  }
}

/*!
 * Normalize polymorphic parameters
 * @param {Object|String} params Name of the polymorphic relation or params
 * @returns {Object} The normalized parameters
 */
function polymorphicParams(params) {
  if (typeof params === 'string') params = { as: params };
  if (typeof params.as !== 'string') params.as = 'reference'; // default
  params.foreignKey = params.foreignKey || i8n.camelize(params.as + '_id', true);
  params.discriminator = params.discriminator || i8n.camelize(params.as + '_type', true);
  return params;
}

/**
 * Define a "one to many" relationship by specifying the model name
 * 
 * Examples:
 * ```
 * User.hasMany(Post, {as: 'posts', foreignKey: 'authorId'});
 * ```
 * 
 * ```
 * Book.hasMany(Chapter);
 * ```
 * Or, equivalently:
 * ```
 * Book.hasMany('chapters', {model: Chapter});
 * ```
 * @param {Model} modelFrom Source model class
 * @param {Object|String} modelTo Model object (or String name of model) to which you are creating the relationship.
 * @options {Object} params Configuration parameters; see below.
 * @property {String} as Name of the property in the referring model that corresponds to the foreign key field in the related model.
 * @property {String} foreignKey Property name of foreign key field.
 * @property {Object} model Model object
 */
RelationDefinition.hasMany = function hasMany(modelFrom, modelTo, params) {
  var thisClassName = modelFrom.modelName;
  params = params || {};
  if (typeof modelTo === 'string') {
    params.as = modelTo;
    if (params.model) {
      modelTo = params.model;
    } else {
      var modelToName = i8n.singularize(modelTo).toLowerCase();
      modelTo = lookupModel(modelFrom.dataSource.modelBuilder.models, modelToName);
    }
  }
  
  var relationName = params.as || i8n.camelize(modelTo.pluralModelName, true);
  var fk = params.foreignKey || i8n.camelize(thisClassName + '_id', true);

  var idName = modelFrom.dataSource.idName(modelFrom.modelName) || 'id';
  var discriminator;
  
  if (params.polymorphic) {
    var polymorphic = polymorphicParams(params.polymorphic);
    discriminator = polymorphic.discriminator;
    if (!params.invert) {
      fk = polymorphic.foreignKey;
    }
    if (!params.through) {
      modelTo.dataSource.defineProperty(modelTo.modelName, discriminator, { type: 'string', index: true });
    }
  }
  
  var definition = new RelationDefinition({
    name: relationName,
    type: RelationTypes.hasMany,
    modelFrom: modelFrom,
    keyFrom: idName,
    keyTo: fk,
    discriminator: discriminator,
    modelTo: modelTo,
    multiple: true,
    properties: params.properties,
    scope: params.scope,
    options: params.options
  });
  
  definition.modelThrough = params.through;
  
  var keyThrough = definition.throughKey || i8n.camelize(modelTo.modelName + '_id', true);
  definition.keyThrough = keyThrough;
  
  modelFrom.relations[relationName] = definition;

  if (!params.through) {
    // obviously, modelTo should have attribute called `fk`
    // for polymorphic relations, it is assumed to share the same fk type for all
    // polymorphic models
    modelTo.dataSource.defineForeignKey(modelTo.modelName, fk, modelFrom.modelName);
  }

  var scopeMethods = {
    findById: scopeMethod(definition, 'findById'),
    destroy: scopeMethod(definition, 'destroyById'),
    updateById: scopeMethod(definition, 'updateById'),
    exists: scopeMethod(definition, 'exists')
  };

  var findByIdFunc = scopeMethods.findById;
  modelFrom.prototype['__findById__' + relationName] = findByIdFunc;

  var destroyByIdFunc = scopeMethods.destroy;
  modelFrom.prototype['__destroyById__' + relationName] = destroyByIdFunc;

  var updateByIdFunc = scopeMethods.updateById;
  modelFrom.prototype['__updateById__' + relationName] = updateByIdFunc;

  var existsByIdFunc = scopeMethods.exists;
  modelFrom.prototype['__exists__' + relationName] = existsByIdFunc;

  if(definition.modelThrough) {
    scopeMethods.create = scopeMethod(definition, 'create');
    scopeMethods.add = scopeMethod(definition, 'add');
    scopeMethods.remove = scopeMethod(definition, 'remove');

    var addFunc = scopeMethods.add;
    modelFrom.prototype['__link__' + relationName] = addFunc;

    var removeFunc = scopeMethods.remove;
    modelFrom.prototype['__unlink__' + relationName] = removeFunc;
  } else {
    scopeMethods.create = scopeMethod(definition, 'create');
    scopeMethods.build = scopeMethod(definition, 'build');
  }
  
  var customMethods = extendScopeMethods(definition, scopeMethods, params.scopeMethods);
  
  for (var i = 0; i < customMethods.length; i++) {
    var methodName = customMethods[i];
    var method = scopeMethods[methodName];
    if (typeof method === 'function' && method.shared === true) {
      modelFrom.prototype['__' + methodName + '__' + relationName] = method;
    }
  };
  
  // Mix the property and scoped methods into the prototype class
  defineScope(modelFrom.prototype, params.through || modelTo, relationName, function () {
    var filter = {};
    filter.where = {};
    filter.where[fk] = this[idName];
    
    definition.applyScope(this, filter);
    
    if (params.through && params.polymorphic && params.invert) {
      filter.where[discriminator] = modelTo.modelName; // overwrite
      filter.collect = params.polymorphic;
      filter.include = filter.collect;
    } else if (params.through) {
      filter.collect = i8n.camelize(modelTo.modelName, true);
      filter.include = filter.collect;
    }
    
    return filter;
  }, scopeMethods, definition.options);

};

function scopeMethod(definition, methodName) {
  var relationClass = RelationClasses[definition.type];
  if (definition.type === RelationTypes.hasMany && definition.modelThrough) {
    relationClass = RelationClasses.hasManyThrough;
  }
  var method = function () {
    var relation = new relationClass(definition, this);
    return relation[methodName].apply(relation, arguments);
  };

  var relationMethod = relationClass.prototype[methodName];
  if (relationMethod.shared) {
    sharedMethod(definition, methodName, method, relationMethod);
  }
  return method;
}

function sharedMethod(definition, methodName, method, relationMethod) {
  method.shared = true;
  method.accepts = relationMethod.accepts;
  method.returns = relationMethod.returns;
  method.http = relationMethod.http;
  method.description = relationMethod.description;
};

/**
 * Find a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Function} cb The callback function
 */
HasMany.prototype.findById = function (fkId, cb) {
  var modelTo = this.definition.modelTo;
  var modelFrom = this.definition.modelFrom;
  var fk = this.definition.keyTo;
  var pk = this.definition.keyFrom;
  var modelInstance = this.modelInstance;

  var idName = this.definition.modelTo.definition.idName();
  var filter = {};
  filter.where = {};
  filter.where[idName] = fkId;
  filter.where[fk] = modelInstance[pk];
  
  if (filter.where[fk] === undefined) {
    // Foreign key is undefined
    return process.nextTick(cb);
  }
  this.definition.applyScope(modelInstance, filter);
  
  modelTo.findOne(filter, function (err, inst) {
    if (err) {
      return cb(err);
    }
    if (!inst) {
      err = new Error('No instance with id ' + fkId + ' found for ' + modelTo.modelName);
      err.statusCode = 404;
      return cb(err);
    }
    // Check if the foreign key matches the primary key
    if (inst[fk] && inst[fk].toString() === modelInstance[pk].toString()) {
      cb(null, inst);
    } else {
      err = new Error('Key mismatch: ' + modelFrom.modelName + '.' + pk
        + ': ' + modelInstance[pk]
        + ', ' + modelTo.modelName + '.' + fk + ': ' + inst[fk]);
      err.statusCode = 400;
      cb(err);
    }
  });
};

/**
 * Find a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Function} cb The callback function
 */
HasMany.prototype.exists = function (fkId, cb) {
  var modelTo = this.definition.modelTo;
  var fk = this.definition.keyTo;
  var pk = this.definition.keyFrom;
  var modelInstance = this.modelInstance;

  modelTo.findById(fkId, function (err, inst) {
    if (err) {
      return cb(err);
    }
    if (!inst) {
      return cb(null, false);
    }
    // Check if the foreign key matches the primary key
    if (inst[fk] && inst[fk].toString() === modelInstance[pk].toString()) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  });
};

/**
 * Update a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Function} cb The callback function
 */
HasMany.prototype.updateById = function (fkId, data, cb) {
  this.findById(fkId, function (err, inst) {
    if (err) {
      return cb && cb(err);
    }
    inst.updateAttributes(data, cb);
  });
};

/**
 * Delete a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Function} cb The callback function
 */
HasMany.prototype.destroyById = function (fkId, cb) {
  var self = this;
  this.findById(fkId, function(err, inst) {
    if (err) {
      return cb(err);
    }
    self.removeFromCache(inst[fkId]);
    inst.destroy(cb);
  });
};

var throughKeys = function(definition) {
  var modelThrough = definition.modelThrough;
  var pk2 = definition.modelTo.definition.idName();
  
  if (definition.discriminator) { // polymorphic
    var fk1 = definition.keyTo;
    var fk2 = definition.keyThrough;
  } else {
    var fk1 = findBelongsTo(modelThrough, definition.modelFrom,
      definition.keyFrom);
    var fk2 = findBelongsTo(modelThrough, definition.modelTo, pk2);
  }
  return [fk1, fk2];
}

/**
 * Find a related item by foreign key
 * @param {*} fkId The foreign key value
 * @param {Function} cb The callback function
 */
HasManyThrough.prototype.findById = function (fkId, cb) {
  var self = this;
  var modelTo = this.definition.modelTo;
  var pk = this.definition.keyFrom;
  var modelInstance = this.modelInstance;
  var modelThrough = this.definition.modelThrough;

  self.exists(fkId, function (err, exists) {
    if (err || !exists) {
      if (!err) {
        err = new Error('No relation found in ' + modelThrough.modelName
          + ' for (' + self.definition.modelFrom.modelName + '.' + modelInstance[pk]
          + ',' + modelTo.modelName + '.' + fkId + ')');
        err.statusCode = 404;
      }
      return cb(err);
    }
    modelTo.findById(fkId, function (err, inst) {
      if (err) {
        return cb(err);
      }
      if (!inst) {
        err = new Error('No instance with id ' + fkId + ' found for ' + modelTo.modelName);
        err.statusCode = 404;
        return cb(err);
      }
      cb(err, inst);
    });
  });
};

/**
 * Delete a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Function} cb The callback function
 */
HasManyThrough.prototype.destroyById = function (fkId, cb) {
  var self = this;
  var modelTo = this.definition.modelTo;
  var pk = this.definition.keyFrom;
  var modelInstance = this.modelInstance;
  var modelThrough = this.definition.modelThrough;

  self.exists(fkId, function (err, exists) {
    if (err || !exists) {
      if (!err) {
        err = new Error('No record found in ' + modelThrough.modelName
          + ' for (' + self.definition.modelFrom.modelName + '.' + modelInstance[pk]
          + ' ,' + modelTo.modelName + '.' + fkId + ')');
        err.statusCode = 404;
      }
      return cb(err);
    }
    self.remove(fkId, function(err) {
      if(err) {
        return cb(err);
      }
      modelTo.deleteById(fkId, cb);
    });
  });
};

// Create an instance of the target model and connect it to the instance of
// the source model by creating an instance of the through model
HasManyThrough.prototype.create = function create(data, done) {
  var self = this;
  var definition = this.definition;
  var modelTo = definition.modelTo;
  var modelThrough = definition.modelThrough;
  
  if (typeof data === 'function' && !done) {
    done = data;
    data = {};
  }

  var modelInstance = this.modelInstance;

  // First create the target model
  modelTo.create(data, function (err, to) {
    if (err) {
      return done && done(err, to);
    }
    // The primary key for the target model
    var pk2 = definition.modelTo.definition.idName();
    
    var keys = throughKeys(definition);
    var fk1 = keys[0];
    var fk2 = keys[1];
    
    var d = {};
    d[fk1] = modelInstance[definition.keyFrom];
    d[fk2] = to[pk2];
    
    definition.applyProperties(modelInstance, d);
    
    // Then create the through model
    modelThrough.create(d, function (e, through) {
      if (e) {
        // Undo creation of the target model
        to.destroy(function () {
          done && done(e);
        });
      } else {
        self.addToCache(to);
        done && done(err, to);
      }
    });
  });
};



/**
 * Add the target model instance to the 'hasMany' relation
 * @param {Object|ID} acInst The actual instance or id value
 */
HasManyThrough.prototype.add = function (acInst, done) {
  var self = this;
  var definition = this.definition;
  var modelThrough = definition.modelThrough;
  var pk1 = definition.keyFrom;

  var data = {};
  var query = {};
  
  // The primary key for the target model
  var pk2 = definition.modelTo.definition.idName();

  var keys = throughKeys(definition);
  var fk1 = keys[0];
  var fk2 = keys[1];
  
  query[fk1] = this.modelInstance[pk1];
  query[fk2] = (acInst instanceof definition.modelTo) ? acInst[pk2] : acInst;
  
  var filter = { where: query };
  
  definition.applyScope(this.modelInstance, filter);

  data[fk1] = this.modelInstance[pk1];
  data[fk2] = (acInst instanceof definition.modelTo) ? acInst[pk2] : acInst;
  
  definition.applyProperties(this.modelInstance, data);

  // Create an instance of the through model
  modelThrough.findOrCreate(filter, data, function(err, ac) {
    if(!err) {
      if (acInst instanceof definition.modelTo) {
        self.addToCache(acInst);
      }
    }
    done(err, ac);
  });
};

/**
 * Check if the target model instance is related to the 'hasMany' relation
 * @param {Object|ID} acInst The actual instance or id value
 */
HasManyThrough.prototype.exists = function (acInst, done) {
  var definition = this.definition;
  var modelThrough = definition.modelThrough;
  var pk1 = definition.keyFrom;

  var query = {};

  // The primary key for the target model
  var pk2 = definition.modelTo.definition.idName();
  
  var keys = throughKeys(definition);
  var fk1 = keys[0];
  var fk2 = keys[1];

  query[fk1] = this.modelInstance[pk1];
  query[fk2] = (acInst instanceof definition.modelTo) ? acInst[pk2] : acInst;
  
  var filter = { where: query };
  
  definition.applyScope(this.modelInstance, filter);
  
  modelThrough.count(filter.where, function(err, ac) {
    done(err, ac > 0);
  });
};

/**
 * Remove the target model instance from the 'hasMany' relation
 * @param {Object|ID) acInst The actual instance or id value
 */
HasManyThrough.prototype.remove = function (acInst, done) {
  var self = this;
  var definition = this.definition;
  var modelThrough = definition.modelThrough;
  var pk1 = definition.keyFrom;

  var query = {};

  // The primary key for the target model
  var pk2 = definition.modelTo.definition.idName();
  
  var keys = throughKeys(definition);
  var fk1 = keys[0];
  var fk2 = keys[1];

  query[fk1] = this.modelInstance[pk1];
  query[fk2] = (acInst instanceof definition.modelTo) ? acInst[pk2] : acInst;
  
  var filter = { where: query };
  
  definition.applyScope(this.modelInstance, filter);
  
  modelThrough.deleteAll(filter.where, function (err) {
    if (!err) {
      self.removeFromCache(query[fk2]);
    }
    done(err);
  });
};


/**
 * Declare "belongsTo" relation that sets up a one-to-one connection with
 * another model, such that each instance of the declaring model "belongs to"
 * one instance of the other model.
 *
 * For example, if an application includes users and posts, and each post can
 * be written by exactly one user. The following code specifies that `Post` has
 * a reference called `author` to the `User` model via the `userId` property of
 * `Post` as the foreign key.
 * ```
 * Post.belongsTo(User, {as: 'author', foreignKey: 'userId'});
 * ```
 *
 * This optional parameter default value is false, so the related object will
 * be loaded from cache if available.
 * 
 * @param {Class|String} modelTo Model object (or String name of model) to
 * which you are creating the relationship.
 * @options {Object} params Configuration parameters; see below.
 * @property {String} as Name of the property in the referring model that
 * corresponds to the foreign key field in the related model.
 * @property {String} foreignKey Name of foreign key property.
 * 
 */
RelationDefinition.belongsTo = function (modelFrom, modelTo, params) {
  var discriminator, polymorphic;
  params = params || {};
  if ('string' === typeof modelTo && !params.polymorphic) {
    params.as = modelTo;
    if (params.model) {
      modelTo = params.model;
    } else {
      var modelToName = modelTo.toLowerCase();
      modelTo = lookupModel(modelFrom.dataSource.modelBuilder.models, modelToName);
    }
  }

  var idName, relationName, fk;
  if (params.polymorphic) {
    if (params.polymorphic === true) {
      // modelTo arg will be the name of the polymorphic relation (string)
      polymorphic = polymorphicParams(modelTo);
    } else {
      polymorphic = polymorphicParams(params.polymorphic);
    }
    
    modelTo = null; // will lookup dynamically
    
    idName = params.idName || 'id';
    relationName = params.as || polymorphic.as;
    fk = polymorphic.foreignKey;
    discriminator = polymorphic.discriminator;
    
    if (typeof polymorphic.idType === 'string') { // explicit key type
      modelFrom.dataSource.defineProperty(modelFrom.modelName, fk, { type: polymorphic.idType, index: true });
    } else { // try to use the same foreign key type as modelFrom
      modelFrom.dataSource.defineForeignKey(modelFrom.modelName, fk, modelFrom.modelName);
    }
    
    modelFrom.dataSource.defineProperty(modelFrom.modelName, discriminator, { type: 'string', index: true });
  } else {
    idName = modelFrom.dataSource.idName(modelTo.modelName) || 'id';
    relationName = params.as || i8n.camelize(modelTo.modelName, true);
    fk = params.foreignKey || relationName + 'Id';
    
    modelFrom.dataSource.defineForeignKey(modelFrom.modelName, fk, modelTo.modelName);
  }
  
  var relationDef = modelFrom.relations[relationName] = new RelationDefinition({
    name: relationName,
    type: RelationTypes.belongsTo,
    modelFrom: modelFrom,
    keyFrom: fk,
    keyTo: idName,
    discriminator: discriminator,
    modelTo: modelTo,
    properties: params.properties,
    scope: params.scope,
    options: params.options
  });
  
  // Define a property for the scope so that we have 'this' for the scoped methods
  Object.defineProperty(modelFrom.prototype, relationName, {
    enumerable: true,
    configurable: true,
    get: function() {
      var relation = new BelongsTo(relationDef, this);
      var relationMethod = relation.related.bind(relation);
      relationMethod.create = relation.create.bind(relation);
      relationMethod.build = relation.build.bind(relation);
      if (relationDef.modelTo) {  
        relationMethod._targetClass = relationDef.modelTo.modelName;
      }
      return relationMethod;
    }
  });

  // FIXME: [rfeng] Wrap the property into a function for remoting
  // so that it can be accessed as /api/<model>/<id>/<belongsToRelationName>
  // For example, /api/orders/1/customer
  var fn = function() {
    var f = this[relationName];
    f.apply(this, arguments);
  };
  modelFrom.prototype['__get__' + relationName] = fn;
};

BelongsTo.prototype.create = function(targetModelData, cb) {
  var self = this;
  var modelTo = this.definition.modelTo;
  var fk = this.definition.keyFrom;
  var pk = this.definition.keyTo;
  var modelInstance = this.modelInstance;

  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }

  this.definition.applyProperties(modelInstance, targetModelData || {});
  
  modelTo.create(targetModelData, function(err, targetModel) {
    if(!err) {
      modelInstance[fk] = targetModel[pk];
      self.resetCache(targetModel);
      cb && cb(err, targetModel);
    } else {
      cb && cb(err);
    }
  });
};

BelongsTo.prototype.build = function(targetModelData) {
  var modelTo = this.definition.modelTo;
  this.definition.applyProperties(this.modelInstance, targetModelData || {});
  return new modelTo(targetModelData);
};

/**
 * Define the method for the belongsTo relation itself
 * It will support one of the following styles:
 * - order.customer(refresh, callback): Load the target model instance asynchronously
 * - order.customer(customer): Synchronous setter of the target model instance
 * - order.customer(): Synchronous getter of the target model instance
 *
 * @param refresh
 * @param params
 * @returns {*}
 */
BelongsTo.prototype.related = function (refresh, params) {
  var self = this;
  var modelFrom = this.definition.modelFrom;
  var modelTo = this.definition.modelTo;
  var discriminator = this.definition.discriminator;
  var pk = this.definition.keyTo;
  var fk = this.definition.keyFrom;
  var modelInstance = this.modelInstance;
  
  if (arguments.length === 1) {
    params = refresh;
    refresh = false;
  } else if (arguments.length > 2) {
    throw new Error('Method can\'t be called with more than two arguments');
  }
  
  var cachedValue;
  if (!refresh) {
    cachedValue = self.getCache();
  }
  if (params instanceof ModelBaseClass) { // acts as setter
    modelTo = params.constructor;
    modelInstance[fk] = params[pk];
    if (discriminator) modelInstance[discriminator] = params.constructor.modelName;
    
    var data = {};
    this.definition.applyProperties(params, data);
    modelInstance.setAttributes(data);
    
    self.resetCache(params);
  } else if (typeof params === 'function') { // acts as async getter
    
    if (discriminator && !modelTo) {
      var modelToName = modelInstance[discriminator];
      if (typeof modelToName !== 'string') {
        throw new Error('Polymorphic model not found: `' + discriminator + '` not set');
      }
      modelToName = modelToName.toLowerCase();
      modelTo = lookupModel(modelFrom.dataSource.modelBuilder.models, modelToName);
      if (!modelTo) {
        throw new Error('Polymorphic model not found: `' + modelToName + '`');
      }
    }
    
    var cb = params;
    if (cachedValue === undefined) {
      var query = {where: {}};
      query.where[pk] = modelInstance[fk];
      
      if (query.where[pk] === undefined) {
        // Foreign key is undefined
        return process.nextTick(cb);
      }
    
      this.definition.applyScope(modelInstance, query);
      
      modelTo.findOne(query, function (err, inst) {
        if (err) {
          return cb(err);
        }
        if (!inst) {
          return cb(null, null);
        }
        // Check if the foreign key matches the primary key
        if (inst[pk] && modelInstance[fk] 
          && inst[pk].toString() === modelInstance[fk].toString()) {
          self.resetCache(inst);
          cb(null, inst);
        } else {
          err = new Error('Key mismatch: ' + self.definition.modelFrom.modelName + '.' + fk
            + ': ' + modelInstance[fk]
            + ', ' + modelTo.modelName + '.' + pk + ': ' + inst[pk]);
          err.statusCode = 400;
          cb(err);
        }
      });
      return modelInstance[fk];
    } else {
      cb(null, cachedValue);
      return cachedValue;
    }
  } else if (params === undefined) { // acts as sync getter
    return cachedValue;
  } else { // setter
    modelInstance[fk] = params;
    self.resetCache();
  }
};

/**
 * A hasAndBelongsToMany relation creates a direct many-to-many connection with
 * another model, with no intervening model. For example, if your application
 * includes users and groups, with each group having many users and each user
 * appearing in many groups, you could declare the models this way:
 * ```
 *  User.hasAndBelongsToMany('groups', {model: Group, foreignKey: 'groupId'});
 * ```
 * 
 * @param {String|Object} modelTo Model object (or String name of model) to
 * which you are creating the relationship.
 * @options {Object} params Configuration parameters; see below.
 * @property {String} as Name of the property in the referring model that
 * corresponds to the foreign key field in the related model.
 * @property {String} foreignKey Property name of foreign key field.
 * @property {Object} model Model object
 */
RelationDefinition.hasAndBelongsToMany = function hasAndBelongsToMany(modelFrom, modelTo, params) {
  params = params || {};
  var models = modelFrom.dataSource.modelBuilder.models;

  if ('string' === typeof modelTo) {
    params.as = modelTo;
    if (params.model) {
      modelTo = params.model;
    } else {
      modelTo = lookupModel(models, i8n.singularize(modelTo)) || modelTo;
    }
    if (typeof modelTo === 'string') {
      throw new Error('Could not find "' + modelTo + '" relation for ' + modelFrom.modelName);
    }
  }
  
  if (!params.through) {
    if (params.polymorphic) throw new Error('Polymorphic relations need a through model');
    var name1 = modelFrom.modelName + modelTo.modelName;
    var name2 = modelTo.modelName + modelFrom.modelName;
    params.through = lookupModel(models, name1) || lookupModel(models, name2) ||
      modelFrom.dataSource.define(name1);
  }
  
  var options = {as: params.as, through: params.through};
  options.properties = params.properties;
  options.scope = params.scope;
  
  if (params.polymorphic) {
    var polymorphic = polymorphicParams(params.polymorphic);
    options.polymorphic = polymorphic; // pass through
    var accessor = params.through.prototype[polymorphic.as];
    if (typeof accessor !== 'function') { // declare once
      // use the name of the polymorphic rel, not modelTo
      params.through.belongsTo(polymorphic.as, { polymorphic: true });
    }
  } else {
    params.through.belongsTo(modelFrom);
  }
  
  params.through.belongsTo(modelTo);
  
  this.hasMany(modelFrom, modelTo, options);

};

/**
 * A HasOne relation creates a one-to-one connection from modelFrom to modelTo.
 * This relation indicates that each instance of a model contains or possesses
 * one instance of another model. For example, each supplier in your application
 * has only one account.
 *
 * @param {Function} modelFrom The declaring model class
 * @param {String|Function} modelTo Model object (or String name of model) to
 * which you are creating the relationship.
 * @options {Object} params Configuration parameters; see below.
 * @property {String} as Name of the property in the referring model that
 * corresponds to the foreign key field in the related model.
 * @property {String} foreignKey Property name of foreign key field.
 * @property {Object} model Model object
 */
RelationDefinition.hasOne = function (modelFrom, modelTo, params) {
  params = params || {};
  if ('string' === typeof modelTo) {
    params.as = modelTo;
    if (params.model) {
      modelTo = params.model;
    } else {
      var modelToName = modelTo.toLowerCase();
      modelTo = lookupModel(modelFrom.dataSource.modelBuilder.models, modelToName);
    }
  }

  var pk = modelFrom.dataSource.idName(modelTo.modelName) || 'id';
  var relationName = params.as || i8n.camelize(modelTo.modelName, true);

  var fk = params.foreignKey || i8n.camelize(modelFrom.modelName + '_id', true);
  var discriminator;
  
  if (params.polymorphic) {
    var polymorphic = polymorphicParams(params.polymorphic);
    fk = polymorphic.foreignKey;
    discriminator = polymorphic.discriminator;
    if (!params.through) {
      modelTo.dataSource.defineProperty(modelTo.modelName, discriminator, { type: 'string', index: true });
    }
  }
  
  var relationDef = modelFrom.relations[relationName] = new RelationDefinition({
    name: relationName,
    type: RelationTypes.hasOne,
    modelFrom: modelFrom,
    keyFrom: pk,
    keyTo: fk,
    discriminator: discriminator,
    modelTo: modelTo,
    properties: params.properties,
    options: params.options
  });

  modelFrom.dataSource.defineForeignKey(modelTo.modelName, fk, modelFrom.modelName);

  // Define a property for the scope so that we have 'this' for the scoped methods
  Object.defineProperty(modelFrom.prototype, relationName, {
    enumerable: true,
    configurable: true,
    get: function() {
      var relation = new HasOne(relationDef, this);
      var relationMethod = relation.related.bind(relation)
      relationMethod.create = relation.create.bind(relation);
      relationMethod.build = relation.build.bind(relation);
      relationMethod._targetClass = relationDef.modelTo.modelName;
      return relationMethod;
    }
  });
  
  // FIXME: [rfeng] Wrap the property into a function for remoting
  // so that it can be accessed as /api/<model>/<id>/<hasOneRelationName>
  // For example, /api/orders/1/customer
  var fn = function() {
    var f = this[relationName];
    f.apply(this, arguments);
  };
  modelFrom.prototype['__get__' + relationName] = fn;
};

/**
 * Create a target model instance
 * @param {Object} targetModelData The target model data
 * @callback {Function} [cb] Callback function
 * @param {String|Object} err Error string or object
 * @param {Object} The newly created target model instance
 */
HasOne.prototype.create = function (targetModelData, cb) {
  var self = this;
  var modelTo = this.definition.modelTo;
  var fk = this.definition.keyTo;
  var pk = this.definition.keyFrom;
  var modelInstance = this.modelInstance;

  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }
  targetModelData = targetModelData || {};
  targetModelData[fk] = modelInstance[pk];
  var query = {where: {}};
  query.where[fk] = targetModelData[fk];
  
  this.definition.applyScope(modelInstance, query);
  this.definition.applyProperties(modelInstance, targetModelData);
  
  modelTo.findOne(query, function(err, result) {
    if(err) {
      cb(err);
    } else if(result) {
      cb(new Error('HasOne relation cannot create more than one instance of '
        + modelTo.modelName));
    } else {
      modelTo.create(targetModelData, function (err, targetModel) {
        if (!err) {
          // Refresh the cache
          self.resetCache(targetModel);
          cb && cb(err, targetModel);
        } else {
          cb && cb(err);
        }
      });
    }
  });
};

/**
 * Create a target model instance
 * @param {Object} targetModelData The target model data
 * @callback {Function} [cb] Callback function
 * @param {String|Object} err Error string or object
 * @param {Object} The newly created target model instance
 */
HasMany.prototype.create = function (targetModelData, cb) {
  var self = this;
  var modelTo = this.definition.modelTo;
  var fk = this.definition.keyTo;
  var pk = this.definition.keyFrom;
  var modelInstance = this.modelInstance;
  
  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }
  targetModelData = targetModelData || {};
  targetModelData[fk] = modelInstance[pk];
  
  this.definition.applyProperties(modelInstance, targetModelData);
  
  modelTo.create(targetModelData, function(err, targetModel) {
    if(!err) {
      // Refresh the cache
      self.addToCache(targetModel);
      cb && cb(err, targetModel);
    } else {
      cb && cb(err);
    }
  });
};
/**
 * Build a target model instance
 * @param {Object} targetModelData The target model data
 * @returns {Object} The newly built target model instance
 */
HasMany.prototype.build = HasOne.prototype.build = function(targetModelData) {
  var modelTo = this.definition.modelTo;
  var pk = this.definition.keyFrom;
  var fk = this.definition.keyTo;
  
  targetModelData = targetModelData || {};
  targetModelData[fk] = this.modelInstance[pk];
  
  this.definition.applyProperties(this.modelInstance, targetModelData);
  
  return new modelTo(targetModelData);
};

/**
 * Define the method for the hasOne relation itself
 * It will support one of the following styles:
 * - order.customer(refresh, callback): Load the target model instance asynchronously
 * - order.customer(customer): Synchronous setter of the target model instance
 * - order.customer(): Synchronous getter of the target model instance
 *
 * @param {Boolean} refresh Reload from the data source
 * @param {Object|Function} params Query parameters
 * @returns {Object}
 */
HasOne.prototype.related = function (refresh, params) {
  var self = this;
  var modelTo = this.definition.modelTo;
  var fk = this.definition.keyTo;
  var pk = this.definition.keyFrom;
  var definition = this.definition;
  var modelInstance = this.modelInstance;

  if (arguments.length === 1) {
    params = refresh;
    refresh = false;
  } else if (arguments.length > 2) {
    throw new Error('Method can\'t be called with more than two arguments');
  }

  var cachedValue;
  if (!refresh) {
    cachedValue = self.getCache();
  }
  if (params instanceof ModelBaseClass) { // acts as setter
    params[fk] = modelInstance[pk];
    self.resetCache(params);
  } else if (typeof params === 'function') { // acts as async getter
    var cb = params;
    if (cachedValue === undefined) {
      var query = {where: {}};
      query.where[fk] = modelInstance[pk];
      definition.applyScope(modelInstance, query);
      modelTo.findOne(query, function (err, inst) {
        if (err) {
          return cb(err);
        }
        if (!inst) {
          return cb(null, null);
        }
        // Check if the foreign key matches the primary key
        if (inst[fk] && modelInstance[pk]
          && inst[fk].toString() === modelInstance[pk].toString()) {
          self.resetCache(inst);
          cb(null, inst);
        } else {
          err = new Error('Key mismatch: ' + self.definition.modelFrom.modelName + '.' + pk
            + ': ' + modelInstance[pk]
            + ', ' + modelTo.modelName + '.' + fk + ': ' + inst[fk]);
          err.statusCode = 400;
          cb(err);
        }
      });
      return modelInstance[pk];
    } else {
      cb(null, cachedValue);
      return cachedValue;
    }
  } else if (params === undefined) { // acts as sync getter
    return cachedValue;
  } else { // setter
    params[fk] = modelInstance[pk];
    self.resetCache();
  }
};

RelationDefinition.embedsMany = function embedsMany(modelFrom, modelTo, params) {
  var thisClassName = modelFrom.modelName;
  params = params || {};
  if (typeof modelTo === 'string') {
    params.as = modelTo;
    if (params.model) {
      modelTo = params.model;
    } else {
      var modelToName = i8n.singularize(modelTo).toLowerCase();
      modelTo = lookupModel(modelFrom.dataSource.modelBuilder.models, modelToName);
    }
  }
  
  var accessorName = params.as || (i8n.camelize(modelTo.modelName, true) + 'List');
  var relationName = params.property || i8n.camelize(modelTo.pluralModelName, true);
  var fk = modelTo.dataSource.idName(modelTo.modelName) || 'id';
  var idName = modelFrom.dataSource.idName(modelFrom.modelName) || 'id';
  
  var definition = modelFrom.relations[accessorName] = new RelationDefinition({
    accessor: accessorName,
    name: relationName,
    type: RelationTypes.embedsMany,
    modelFrom: modelFrom,
    keyFrom: idName,
    keyTo: fk,
    modelTo: modelTo,
    multiple: true,
    properties: params.properties,
    scope: params.scope,
    options: params.options,
    embed: true
  });
  
  modelFrom.dataSource.defineProperty(modelFrom.modelName, relationName, { 
    type: [modelTo], default: function() { return []; } 
  });
  
  // unique id is required
  modelTo.validatesPresenceOf(idName);
  
  if (!params.polymorphic) {
    modelFrom.validate(relationName, function(err) {
      var embeddedList = this[relationName] || [];
      var ids = embeddedList.map(function(m) { return m[idName]; });
      var uniqueIds = ids.filter(function(id, pos) {
          return ids.indexOf(id) === pos;
      });
      if (ids.length !== uniqueIds.length) {
        this.errors.add(relationName, 'Contains duplicate `' + idName + '`', 'uniqueness');
        err(false);
      }
    }, { code: 'uniqueness' })
  }
  
  // validate all embedded items
  if (definition.options.validate) {
    modelFrom.validate(relationName, function(err) {
      var self = this;
      var embeddedList = this[relationName] || [];
      var hasErrors = false;
      embeddedList.forEach(function(item) {
        if (item instanceof modelTo) {
          if (!item.isValid()) {
            hasErrors = true;
            var id = item[idName] || '(blank)';
            var first = Object.keys(item.errors)[0];
            var msg = 'contains invalid item: `' + id + '`';
            msg += ' (' + first + ' ' + item.errors[first] + ')';
            self.errors.add(relationName, msg, 'invalid');
          }
        } else {
          hasErrors = true;
          self.errors.add(relationName, 'Contains invalid item', 'invalid');
        }
      });
      if (hasErrors) err(false);
    });
  }
  
  var scopeMethods = {
    findById: scopeMethod(definition, 'findById'),
    destroy: scopeMethod(definition, 'destroyById'),
    updateById: scopeMethod(definition, 'updateById'),
    exists: scopeMethod(definition, 'exists'),
    add: scopeMethod(definition, 'add'),
    remove: scopeMethod(definition, 'remove'),
    get: scopeMethod(definition, 'get'),
    set: scopeMethod(definition, 'set'),
    unset: scopeMethod(definition, 'unset'),
    at: scopeMethod(definition, 'at')
  };
  
  var findByIdFunc = scopeMethods.findById;
  modelFrom.prototype['__findById__' + accessorName] = findByIdFunc;
  
  var destroyByIdFunc = scopeMethods.destroy;
  modelFrom.prototype['__destroyById__' + accessorName] = destroyByIdFunc;
  
  var updateByIdFunc = scopeMethods.updateById;
  modelFrom.prototype['__updateById__' + accessorName] = updateByIdFunc;
  
  var addFunc = scopeMethods.add;
  modelFrom.prototype['__link__' + accessorName] = addFunc;

  var removeFunc = scopeMethods.remove;
  modelFrom.prototype['__unlink__' + accessorName] = removeFunc;

  scopeMethods.create = scopeMethod(definition, 'create');
  scopeMethods.build = scopeMethod(definition, 'build');
  
  scopeMethods.related = scopeMethod(definition, 'related'); // bound to definition
  
  var customMethods = extendScopeMethods(definition, scopeMethods, params.scopeMethods);
  
  for (var i = 0; i < customMethods.length; i++) {
    var methodName = customMethods[i];
    var method = scopeMethods[methodName];
    if (typeof method === 'function' && method.shared === true) {
      modelFrom.prototype['__' + methodName + '__' + accessorName] = method;
    }
  };
  
  // Mix the property and scoped methods into the prototype class
  var scopeDefinition = defineScope(modelFrom.prototype, modelTo, accessorName, function () {
    return {};
  }, scopeMethods, definition.options);

  scopeDefinition.related = scopeMethods.related;
};

EmbedsMany.prototype.related = function(receiver, scopeParams, condOrRefresh, cb) {
  var modelTo = this.definition.modelTo;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  var self = receiver;
  
  var actualCond = {};
  var actualRefresh = false;
  if (arguments.length === 3) {
    cb = condOrRefresh;
  } else if (arguments.length === 4) {
    if (typeof condOrRefresh === 'boolean') {
      actualRefresh = condOrRefresh;
    } else {
      actualCond = condOrRefresh;
      actualRefresh = true;
    }
  } else {
    throw new Error('Method can be only called with one or two arguments');
  }
  
  var embeddedList = self[relationName] || [];
  
  this.definition.applyScope(modelInstance, actualCond);
  
  var params = mergeQuery(actualCond, scopeParams);
  
  if (params.where) {
    embeddedList = embeddedList ? embeddedList.filter(applyFilter(params)) : embeddedList;
  }
  
  var returnRelated = function(list) {
    if (params.include) {
      modelTo.include(list, params.include, cb);
    } else {
      process.nextTick(function() { cb(null, list); });
    }
  };
  
  returnRelated(embeddedList);
};

EmbedsMany.prototype.findById = function (fkId, cb) {
  var pk = this.definition.keyFrom;
  var modelTo = this.definition.modelTo;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  
  var embeddedList = modelInstance[relationName] || [];
  
  var find = function(id) {
    for (var i = 0; i < embeddedList.length; i++) {
      var item = embeddedList[i];
      if (item[pk].toString() === id) return item;
    }
    return null;
  };
  
  var item = find(fkId.toString()); // in case of explicit id
  item = (item instanceof modelTo) ? item : null;
  
  if (typeof cb === 'function') {
    process.nextTick(function() {
      cb(null, item);
    });
  };
  
  return item; // sync 
};

EmbedsMany.prototype.exists = function (fkId, cb) {
  var modelTo = this.definition.modelTo;
  var inst = this.findById(fkId, function (err, inst) {
    if (cb) cb(err, inst instanceof modelTo);
  });
  return inst instanceof modelTo; // sync 
};

EmbedsMany.prototype.updateById = function (fkId, data, cb) {
  if (typeof data === 'function') {
    cb = data;
    data = {};
  }
  
  var modelTo = this.definition.modelTo;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  
  var embeddedList = modelInstance[relationName] || [];
  
  var inst = this.findById(fkId);
  
  if (inst instanceof modelTo) {
    if (typeof data === 'object') {
      for (var key in data) {
        inst[key] = data[key];
      }
    }
    var err = inst.isValid() ? null : new ValidationError(inst);
    if (err && typeof cb === 'function') {
      return process.nextTick(function() { 
        cb(err, inst); 
      });
    }
    
    if (typeof cb === 'function') {
      modelInstance.updateAttribute(relationName, 
        embeddedList, function(err) {
        cb(err, inst);
      });
    }
  } else if (typeof cb === 'function') {
    process.nextTick(function() { 
      cb(null, null); // not found
    });
  }
  return inst; // sync 
};

EmbedsMany.prototype.destroyById = function (fkId, cb) {
  var modelTo = this.definition.modelTo;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  
  var embeddedList = modelInstance[relationName] || [];
  
  var inst = (fkId instanceof modelTo) ? fkId : this.findById(fkId);
  
  if (inst instanceof modelTo) {
    var index = embeddedList.indexOf(inst);
    if (index > -1) embeddedList.splice(index, 1);
    if (typeof cb === 'function') {
      modelInstance.updateAttribute(relationName, 
        embeddedList, function(err) {
        cb(err);
      });
    }
  } else if (typeof cb === 'function') {
    process.nextTick(cb); // not found
  }
  return inst; // sync
};

EmbedsMany.prototype.get = EmbedsMany.prototype.findById;
EmbedsMany.prototype.set = EmbedsMany.prototype.updateById;
EmbedsMany.prototype.unset = EmbedsMany.prototype.destroyById;

EmbedsMany.prototype.at = function (index, cb) {
  var modelTo = this.definition.modelTo;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  
  var embeddedList = modelInstance[relationName] || [];
  
  var item = embeddedList[parseInt(index)];
  item = (item instanceof modelTo) ? item : null;
  
  if (typeof cb === 'function') {
    process.nextTick(function() {
      cb(null, item);
    });
  };
  
  return item; // sync 
};

EmbedsMany.prototype.create = function (targetModelData, cb) {
  var pk = this.definition.keyFrom;
  var modelTo = this.definition.modelTo;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  var autoId = this.definition.options.autoId !== false;
  
  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }
  targetModelData = targetModelData || {};
  
  var embeddedList = modelInstance[relationName] || [];
  
  var inst = this.build(targetModelData);
  
  var err = inst.isValid() ? null : new ValidationError(inst);
  
  if (err) {
    return process.nextTick(function() {
      cb(err); 
    });
  }
  
  modelInstance.updateAttribute(relationName,
    embeddedList, function(err, modelInst) {
    cb(err, err ? null : inst);
  });
};

EmbedsMany.prototype.build = function(targetModelData) {
  var pk = this.definition.keyFrom;
  var modelTo = this.definition.modelTo;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  var autoId = this.definition.options.autoId !== false;
  
  var embeddedList = modelInstance[relationName] || [];
  
  targetModelData = targetModelData || {};
  
  if (typeof targetModelData[pk] !== 'number' && autoId) {
    var ids = embeddedList.map(function(m) { 
      return (typeof m[pk] === 'number' ? m[pk] : 0);
    });
    if (ids.length > 0) {
      targetModelData[pk] = Math.max.apply(null, ids) + 1;
    } else {
      targetModelData[pk] = 1;
    }
  }
  
  this.definition.applyProperties(this.modelInstance, targetModelData);
  
  var inst = new modelTo(targetModelData);
  
  if (this.definition.options.prepend) {
    embeddedList.unshift(inst);
  } else {
    embeddedList.push(inst);
  }
  
  return inst;
};

/**
 * Add the target model instance to the 'embedsMany' relation
 * @param {Object|ID} acInst The actual instance or id value
 */
EmbedsMany.prototype.add = function (acInst, data, cb) {
  if (typeof data === 'function') {
    cb = data;
    data = {};
  }
  
  var self = this;
  var definition = this.definition;
  var modelTo = this.definition.modelTo;
  var modelInstance = this.modelInstance;
  
  var options = definition.options;
  var belongsTo = options.belongsTo && modelTo.relations[options.belongsTo];
  
  if (!belongsTo) {
    throw new Error('Invalid reference: ' + options.belongsTo || '(none)');
  }
  
  var fk2 = belongsTo.keyTo;
  var pk2 = belongsTo.modelTo.definition.idName() || 'id';
  
  var query = {};
  
  query[fk2] = (acInst instanceof belongsTo.modelTo) ? acInst[pk2] : acInst;
  
  var filter = { where: query };
  
  belongsTo.applyScope(modelInstance, filter);
  
  belongsTo.modelTo.findOne(filter, function(err, ref) {
    if (ref instanceof belongsTo.modelTo) {
      var inst = self.build(data || {});
      inst[options.belongsTo](ref);
      modelInstance.save(function(err) {
        cb(err, err ? null : inst);
      });
    } else {
      cb(null, null);
    }
  });
};

/**
 * Remove the target model instance from the 'embedsMany' relation
 * @param {Object|ID) acInst The actual instance or id value
 */
EmbedsMany.prototype.remove = function (acInst, cb) {
  var self = this;
  var definition = this.definition;
  var modelTo = this.definition.modelTo;
  var modelInstance = this.modelInstance;
  
  var options = definition.options;
  var belongsTo = options.belongsTo && modelTo.relations[options.belongsTo];
  
  if (!belongsTo) {
    throw new Error('Invalid reference: ' + options.belongsTo || '(none)');
  }
  
  var fk2 = belongsTo.keyTo;
  var pk2 = belongsTo.modelTo.definition.idName() || 'id';
  
  var query = {};
  
  query[fk2] = (acInst instanceof belongsTo.modelTo) ? acInst[pk2] : acInst;
  
  var filter = { where: query };
  
  belongsTo.applyScope(modelInstance, filter);
  
  modelInstance[definition.accessor](filter, function(err, items) {
    if (err) return cb(err);
    
    items.forEach(function(item) {
      self.unset(item);
    });
    
    modelInstance.save(function(err) {
      cb(err);
    });
  });
};

RelationDefinition.referencesMany = function referencesMany(modelFrom, modelTo, params) {
  var thisClassName = modelFrom.modelName;
  params = params || {};
  if (typeof modelTo === 'string') {
    params.as = modelTo;
    if (params.model) {
      modelTo = params.model;
    } else {
      var modelToName = i8n.singularize(modelTo).toLowerCase();
      modelTo = lookupModel(modelFrom.dataSource.modelBuilder.models, modelToName);
    }
  }
  
  var relationName = params.as || i8n.camelize(modelTo.pluralModelName, true);
  var fk = params.foreignKey || i8n.camelize(modelTo.modelName + '_ids', true);
  var idName = modelTo.dataSource.idName(modelTo.modelName) || 'id';
  var idType = modelTo.definition.properties[idName].type;
  
  var definition = modelFrom.relations[relationName] = new RelationDefinition({
    name: relationName,
    type: RelationTypes.referencesMany,
    modelFrom: modelFrom,
    keyFrom: fk,
    keyTo: idName,
    modelTo: modelTo,
    multiple: true,
    properties: params.properties,
    scope: params.scope,
    options: params.options
  });
  
  modelFrom.dataSource.defineProperty(modelFrom.modelName, fk, { 
    type: [idType], default: function() { return []; } 
  });
  
  modelFrom.validate(relationName, function(err) {
    var ids = this[fk] || [];
    var uniqueIds = ids.filter(function(id, pos) {
        return ids.indexOf(id) === pos;
    });
    if (ids.length !== uniqueIds.length) {
      var msg = 'Contains duplicate `' + modelTo.modelName + '` instance';
      this.errors.add(relationName, msg, 'uniqueness');
      err(false);
    }
  }, { code: 'uniqueness' })
  
  var scopeMethods = {
    findById: scopeMethod(definition, 'findById'),
    destroy: scopeMethod(definition, 'destroyById'),
    updateById: scopeMethod(definition, 'updateById'),
    exists: scopeMethod(definition, 'exists'),
    add: scopeMethod(definition, 'add'),
    remove: scopeMethod(definition, 'remove'),
    at: scopeMethod(definition, 'at')
  };
  
  var findByIdFunc = scopeMethods.findById;
  modelFrom.prototype['__findById__' + relationName] = findByIdFunc;
  
  var destroyByIdFunc = scopeMethods.destroy;
  modelFrom.prototype['__destroyById__' + relationName] = destroyByIdFunc;
  
  var updateByIdFunc = scopeMethods.updateById;
  modelFrom.prototype['__updateById__' + relationName] = updateByIdFunc;
  
  var addFunc = scopeMethods.add;
  modelFrom.prototype['__link__' + relationName] = addFunc;

  var removeFunc = scopeMethods.remove;
  modelFrom.prototype['__unlink__' + relationName] = removeFunc;
  
  scopeMethods.create = scopeMethod(definition, 'create');
  scopeMethods.build = scopeMethod(definition, 'build');
  
  scopeMethods.related = scopeMethod(definition, 'related');
  
  var customMethods = extendScopeMethods(definition, scopeMethods, params.scopeMethods);
  
  for (var i = 0; i < customMethods.length; i++) {
    var methodName = customMethods[i];
    var method = scopeMethods[methodName];
    if (typeof method === 'function' && method.shared === true) {
      modelFrom.prototype['__' + methodName + '__' + relationName] = method;
    }
  };
  
  // Mix the property and scoped methods into the prototype class
  var scopeDefinition = defineScope(modelFrom.prototype, modelTo, relationName, function () {
    return {};
  }, scopeMethods, definition.options);
  
  scopeDefinition.related = scopeMethods.related; // bound to definition
};

ReferencesMany.prototype.related = function(receiver, scopeParams, condOrRefresh, cb) {
  var fk = this.definition.keyFrom;
  var modelTo = this.definition.modelTo;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  var self = receiver;
  
  var actualCond = {};
  var actualRefresh = false;
  if (arguments.length === 3) {
    cb = condOrRefresh;
  } else if (arguments.length === 4) {
    if (typeof condOrRefresh === 'boolean') {
      actualRefresh = condOrRefresh;
    } else {
      actualCond = condOrRefresh;
      actualRefresh = true;
    }
  } else {
    throw new Error('Method can be only called with one or two arguments');
  }
  
  var ids = self[fk] || [];
  
  this.definition.applyScope(modelInstance, actualCond);
  
  var params = mergeQuery(actualCond, scopeParams);
  
  modelTo.findByIds(ids, params, cb);
};

ReferencesMany.prototype.findById = function (fkId, cb) {
  var modelTo = this.definition.modelTo;
  var modelFrom = this.definition.modelFrom;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  
  var modelTo = this.definition.modelTo;
  var pk = this.definition.keyTo;
  var fk = this.definition.keyFrom;
  
  if (typeof fkId === 'object') {
    fkId = fkId.toString(); // mongodb
  }
  
  var ids = [fkId];
  
  var filter = {};
  
  this.definition.applyScope(modelInstance, filter);
  
  modelTo.findByIds(ids, filter, function (err, instances) {
    if (err) {
      return cb(err);
    }
    
    var inst = instances[0];
    if (!inst) {
      err = new Error('No instance with id ' + fkId + ' found for ' + modelTo.modelName);
      err.statusCode = 404;
      return cb(err);
    }
    
    var currentIds = ids.map(function(id) { return id.toString(); });
    var id = (inst[pk] || '').toString(); // mongodb
    
    // Check if the foreign key is amongst the ids
    if (currentIds.indexOf(id) > -1) {
      cb(null, inst);
    } else {
      err = new Error('Key mismatch: ' + modelFrom.modelName + '.' + fk
        + ': ' + modelInstance[fk]
        + ', ' + modelTo.modelName + '.' + pk + ': ' + inst[pk]);
      err.statusCode = 400;
      cb(err);
    }
  });
};

ReferencesMany.prototype.exists = function (fkId, cb) {
  var fk = this.definition.keyFrom;
  var ids = this.modelInstance[fk] || [];
  var currentIds = ids.map(function(id) { return id.toString(); });
  var fkId = (fkId || '').toString(); // mongodb
  process.nextTick(function() { cb(null, currentIds.indexOf(fkId) > -1) });
};

ReferencesMany.prototype.updateById = function (fkId, data, cb) {
  if (typeof data === 'function') {
    cb = data;
    data = {};
  }
  
  this.findById(fkId, function(err, inst) {
    if (err) return cb(err);
    inst.updateAttributes(data, cb);
  });
};

ReferencesMany.prototype.destroyById = function (fkId, cb) {
  var self = this;
  this.findById(fkId, function(err, inst) {
    if (err) return cb(err);
    self.remove(inst, function(err, ids) {
      inst.destroy(cb);
    });
  });
};

ReferencesMany.prototype.at = function (index, cb) {
  var fk = this.definition.keyFrom;
  var ids = this.modelInstance[fk] || [];
  this.findById(ids[index], cb);
};

ReferencesMany.prototype.create = function (targetModelData, cb) {
  var definition = this.definition;
  var modelTo = this.definition.modelTo;
  var relationName = this.definition.name;
  var modelInstance = this.modelInstance;
  
  var pk = this.definition.keyTo;
  var fk = this.definition.keyFrom;
  
  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }
  targetModelData = targetModelData || {};
  
  var ids = modelInstance[fk] || [];
  
  var inst = this.build(targetModelData);
  
  inst.save(function(err, inst) {
    if (err) return cb(err, inst);
    
    var id = inst[pk];
    
    if (typeof id === 'object') {
      id = id.toString(); // mongodb
    }
    
    if (definition.options.prepend) {
      ids.unshift(id);
    } else {
      ids.push(id);
    }
    
    modelInstance.updateAttribute(fk,
      ids, function(err, modelInst) {
      cb(err, inst);
    });
  });
};

ReferencesMany.prototype.build = function(targetModelData) {
  var modelTo = this.definition.modelTo;
  targetModelData = targetModelData || {};
  
  this.definition.applyProperties(this.modelInstance, targetModelData);
  
  return new modelTo(targetModelData);
};

/**
 * Add the target model instance to the 'embedsMany' relation
 * @param {Object|ID} acInst The actual instance or id value
 */
ReferencesMany.prototype.add = function (acInst, cb) {
  var self = this;
  var definition = this.definition;
  var modelTo = this.definition.modelTo;
  var modelInstance = this.modelInstance;
  
  var pk = this.definition.keyTo;
  var fk = this.definition.keyFrom;
  
  var insert = function(inst, done) {
    var id = inst[pk];
    
    if (typeof id === 'object') {
      id = id.toString(); // mongodb
    }
    
    var ids = modelInstance[fk] || [];
    
    if (definition.options.prepend) {
      ids.unshift(id);
    } else {
      ids.push(id);
    }
    
    modelInstance.updateAttribute(fk, ids, function(err) {
      done(err, err ? null : inst);
    });
  };
  
  if (acInst instanceof modelTo) {
    insert(acInst, cb);
  } else {
    var filter = { where: {} };
    filter.where[pk] = acInst;
    
    definition.applyScope(modelInstance, filter);
    
    modelTo.findOne(filter, function (err, inst) {
      if (err || !inst) return cb(err, null);
      insert(inst, cb);
    });
  }
};

/**
 * Remove the target model instance from the 'embedsMany' relation
 * @param {Object|ID) acInst The actual instance or id value
 */
ReferencesMany.prototype.remove = function (acInst, cb) {
  var definition = this.definition;
  var modelInstance = this.modelInstance;
  
  var pk = this.definition.keyTo;
  var fk = this.definition.keyFrom;
  
  var ids = modelInstance[fk] || [];
  
  var currentIds = ids.map(function(id) { return id.toString(); });
  
  var id = (acInst instanceof definition.modelTo) ? acInst[pk] : acInst;
  id = id.toString();
  
  var index = currentIds.indexOf(id);
  if (index > -1) {
    ids.splice(index, 1);
    modelInstance.updateAttribute(fk, ids, function(err, inst) {
      cb(err, inst[fk] || []);
    });
  } else {
    process.nextTick(function() { cb(null, ids); });
  }
};