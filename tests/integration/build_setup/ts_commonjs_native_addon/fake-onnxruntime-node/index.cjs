exports.status = () => 'native-addon-ok';

exports.loadBinding = () => {
  return require('./binding.node');
};
