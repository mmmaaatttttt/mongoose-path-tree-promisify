var mongoose = require('mongoose');
var Promise = require('bluebird');
mongoose.Promise = Promise;
var Schema = mongoose.Schema;
var streamWorker = require('stream-worker');

/**
 * @class Tree
 * Tree Behavior for Mongoose
 *
 * Implements the materialized path strategy with cascade child re-parenting
 * on delete for storing a hierarchy of documents with Mongoose
 *
 * @param  {Mongoose.Schema} schema
 * @param  {Object} options
 */
function tree(schema, options) {

  var pathSeparator = options && options.pathSeparator || '#';
  var wrapChildrenTree = options && options.wrapChildrenTree;
  var onDelete = options && options.onDelete || 'DELETE'; //'REPARENT'
  var numWorkers = options && options.numWorkers || 5;
  var idType = options && options.idType || Schema.ObjectId;
  var pathSeparatorRegex = '[' + pathSeparator + ']';

  /**
   * Add parent and path properties
   *
   * @property {ObjectID} parent
   * @property {String} path
   */
  schema.add({
    parent: {
      type: idType,
      set: function (val) {
        return (val instanceof Object && val._id) ? val._id : val;
      },
      index: true
    },
    path: {
      type: String,
      index: true
    }
  });


  /**
   * Pre-save middleware
   * Build or rebuild path when needed
   *
   * @param  {Function} next
   */
  schema.pre('save', function preSave(next) {

    var isParentChange = this.isModified('parent');

    if (this.isNew || isParentChange) {
      if (!this.parent) {
        this.path = this._id.toString();
        return Promise.resolve().asCallback(next);
      }

      var self = this;
      return this.constructor.findOne({ _id: this.parent })
      .then(function (parentDoc) {
        var previousPath = self.path;
        self.path = parentDoc.path + pathSeparator + self._id.toString();
        // When the parent is changed we must rewrite all children paths as well
        if (isParentChange) {
          return Promise.all([
            self.constructor.find({path: {'$regex': '^' + previousPath + pathSeparatorRegex}}),
            previousPath,
            self.path
          ])
        } else {
          return Promise.resolve();
        }
      })
      // use then function to replace spread function
      // .spread(function (docs, previousPath, parentPath) {
      .then(function (result) {
        if (result[0]) {
          var promises = [];
          result[0].forEach(function (doc) {
            var newPath = result[2] + doc.path.substr(result[1].length);
            promises.push(self.constructor.findByIdAndUpdate(doc._id, { $set: { path: newPath } }));
          });
          return Promise.all(promises);
        } else {
          return Promise.resolve();
        }
      })
      .then(function (result) {
        return;
      })
      .catch(function (err) {
        throw err;
      })
      .asCallback(next);
    } else {
      return Promise.resolve().asCallback(next);
    }

  });


  /**
   * @method getChildren
   *
   * @param  {Object}               filters (like for mongo find) (optional)
   * @param  {Object} or {String}   fields  (like for mongo find) (optional)
   * @param  {Object}               options (like for mongo find) (optional)
   * @param  {Boolean}              recursive, default false      (optional)
   * @return {Model}
   */
  schema.methods.getChildren = function getChildren(filters, fields, options, recursive) {

    if ('boolean' === typeof filters) {
      recursive = filters
      filters = {};
      fields = null;
      options = {};
    } else if ('boolean' === typeof fields) {
      recursive = fields;
      fields = null;
      options = {};
    } else if ('boolean' === typeof options) {
      recursive = options;
      options = {};
    }

    filters = filters || {};
    fields = fields || null;
    options = options || {};
    recursive = recursive || false;

    if (recursive) {
      if(filters['$query']){
        filters['$query']['path'] = {$regex: '^' + this.path + pathSeparatorRegex};
      } else {
        filters['path'] = {$regex: '^' + this.path + pathSeparatorRegex};
      }
    } else {
      if(filters['$query']){
        filters['$query']['parent'] = this._id;
      } else {
        filters['parent'] = this._id;
      }
    }

    return this.model(this.constructor.modelName).find(filters, fields, options);
  };


  /**
   * @method getParent
   *
   * @param  {Function} next
   * @return {Model}
   */
  schema.methods.getParent = function getParent() {
    return this.model(this.constructor.modelName).findOne({ _id: this.parent });
  };


  /**
   * @method getAncestors
   *
   * @param  {Object}   args
   * @return {Model}
   */
  schema.methods.getAncestors = function getAncestors(filters, fields, options) {

    filters = filters || {};
    fields = fields || null;
    options = options || {};

    var ids = [];

    if (this.path) {
      ids = this.path.split(pathSeparator);
      ids.pop();
    }

    if(filters['$query']){
      filters['$query']['_id'] = { $in: ids };
    } else {
      filters['_id'] = { $in: ids };
    }

    return this.model(this.constructor.modelName).find(filters, fields, options);
  };

  /**
   * @property {Number} level <virtual>
   */
  schema.virtual('level').get(function virtualPropLevel() {
    return this.path ? this.path.split(pathSeparator).length : 0;
  });
}

module.exports = tree;
